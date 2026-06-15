// QHT Clinic - Drive -> YouTube transfer server (two-account + scheduled jobs).
//
// Endpoints:
//   POST /api/transfer  { driveUrl, title, description, tags, status, publishAt }  -> immediate upload (streams progress)
//   GET  /process-due   -> uploads any scheduled videos whose time has passed (called by a cron)
//   GET  /auth, /oauth2callback -> one-time sign-in to get refresh tokens
//
// Env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//   GOOGLE_REFRESH_TOKEN_DRIVE   -> account that can read the Drive folder
//   GOOGLE_REFRESH_TOKEN_YT      -> account that owns the YouTube channel
//   GOOGLE_REFRESH_TOKEN         -> optional fallback for both
//   CF_DATA_URL                  -> the Cloudflare Worker URL that stores the videos list (for scheduled jobs)
//   CF_DATA_KEY (optional)       -> access key for that Worker
//   ACCESS_KEY (optional), ALLOWED_ORIGIN (optional), PORT

import express from "express";
import { google } from "googleapis";

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_REFRESH_TOKEN_DRIVE,
  GOOGLE_REFRESH_TOKEN_YT,
  CF_DATA_URL,
  CF_DATA_KEY,
  ACCESS_KEY,
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
} = process.env;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/drive.readonly",
];

const driveToken = () => GOOGLE_REFRESH_TOKEN_DRIVE || GOOGLE_REFRESH_TOKEN;
const ytToken = () => GOOGLE_REFRESH_TOKEN_YT || GOOGLE_REFRESH_TOKEN;

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,x-access-key");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function oauthClient() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
function clientFor(token) {
  const o = oauthClient();
  o.setCredentials({ refresh_token: token });
  return o;
}
function driveIdFromLink(link) {
  const s = String(link || "");
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/\/d\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : "";
}

// ---- the actual Drive -> YouTube transfer (used by both immediate and scheduled paths) ----
async function runTransfer(job, onProgress) {
  const drive = google.drive({ version: "v3", auth: clientFor(driveToken()) });
  const youtube = google.youtube({ version: "v3", auth: clientFor(ytToken()) });

  const folderId = driveIdFromLink(job.driveUrl);
  if (!folderId) throw new Error("Could not read a folder id from that Drive link.");

  const list = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: "files(id,name,mimeType,size)",
    pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  const files = list.data.files || [];
  const video = files.find((f) => (f.mimeType || "").startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name));
  const image = files.find((f) => (f.mimeType || "").startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name));
  if (!video) throw new Error("No video file found. Files seen: " + files.map((f) => f.name).join(", "));
  if (onProgress) onProgress({ stage: "found", message: "Found " + video.name, video: video.name, image: image ? image.name : null });

  const videoStream = (await drive.files.get({ fileId: video.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })).data;
  const total = Number(video.size || 0);
  if (onProgress) onProgress({ stage: "uploading", message: "Uploading to YouTube...", total });

  const privacy = ["public", "unlisted", "private"].includes(String(job.status || "").toLowerCase()) ? String(job.status).toLowerCase() : "private";
  const statusObj = { privacyStatus: privacy };
  if (job.publishAt) { statusObj.privacyStatus = "private"; statusObj.publishAt = job.publishAt; }

  let lastPct = -1;
  const insert = await youtube.videos.insert(
    {
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: job.title || video.name, description: job.description || "", tags: Array.isArray(job.tags) ? job.tags : [], categoryId: "22" },
        status: statusObj,
      },
      media: { body: videoStream },
    },
    { onUploadProgress: (e) => { if (!total || !onProgress) return; const pct = Math.round((e.bytesRead / total) * 100); if (pct !== lastPct) { lastPct = pct; onProgress({ stage: "progress", uploaded: e.bytesRead, total, pct }); } } }
  );

  const videoId = insert.data.id;
  let thumbnailSet = false;
  let thumbError = null;
  if (image) {
    try {
      const imgStream = (await drive.files.get({ fileId: image.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })).data;
      await youtube.thumbnails.set({ videoId, media: { mimeType: image.mimeType || "image/jpeg", body: imgStream } });
      thumbnailSet = true;
      console.log("THUMBNAIL OK for", videoId, "image:", image.name);
      if (onProgress) onProgress({ stage: "thumbnail", message: "Thumbnail set" });
    } catch (e) {
      thumbError = (e && e.message ? e.message : String(e));
      console.error("THUMBNAIL FAILED for", videoId, "image:", image.name, "->", thumbError);
      if (onProgress) onProgress({ stage: "thumbnail_failed", message: "Thumbnail failed: " + thumbError });
    }
  } else {
    thumbError = "no image file found in the folder";
    console.log("THUMBNAIL: no image found in folder for", videoId);
  }
  return { videoId, privacy, title: job.title || video.name, thumbnailSet, thumbError };
}

// ---- Cloudflare KV (videos list) read/write, used for scheduled jobs ----
async function readList() {
  if (!CF_DATA_URL) throw new Error("CF_DATA_URL not set");
  const r = await fetch(CF_DATA_URL, { headers: CF_DATA_KEY ? { "x-access-key": CF_DATA_KEY } : {} });
  if (!r.ok) throw new Error("read list failed " + r.status);
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}
async function writeList(listData) {
  const r = await fetch(CF_DATA_URL, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(CF_DATA_KEY ? { "x-access-key": CF_DATA_KEY } : {}) },
    body: JSON.stringify(listData),
  });
  if (!r.ok) throw new Error("write list failed " + r.status);
}

// ---- one-time auth ----
app.get("/auth", (_req, res) => {
  const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  res.redirect(url);
});
app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oauthClient().getToken(req.query.code);
    const rt = tokens.refresh_token;
    res.type("html").send(rt
      ? `<h2>Success</h2><p>Copy this refresh token (use as GOOGLE_REFRESH_TOKEN_DRIVE or GOOGLE_REFRESH_TOKEN_YT), then redeploy:</p><pre style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:12px">${rt}</pre>`
      : `<h2>No refresh token.</h2><p>Remove the app at myaccount.google.com/permissions, then open /auth again.</p>`);
  } catch (e) {
    res.status(500).send("Auth failed: " + (e && e.message ? e.message : String(e)));
  }
});

// ---- immediate upload (streams progress) ----
app.post("/api/transfer", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  if (!driveToken() || !ytToken()) return res.status(500).json({ error: "Server not authorized yet - set GOOGLE_REFRESH_TOKEN_DRIVE and GOOGLE_REFRESH_TOKEN_YT." });

  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-cache");
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };

  try {
    send({ stage: "listing", message: "Reading the Drive folder..." });
    const result = await runTransfer(req.body, send);
    send({ stage: "done", videoId: result.videoId, title: result.title, privacy: result.privacy });
  } catch (e) {
    send({ error: e && e.message ? e.message : String(e) });
  } finally {
    res.end();
  }
});

// ---- delete a video from YouTube (called when deleting from the dashboard) ----
app.post("/api/delete", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  const videoId = req.body && req.body.videoId;
  if (!videoId) return res.status(400).json({ error: "videoId required" });
  try {
    const youtube = google.youtube({ version: "v3", auth: clientFor(ytToken()) });
    await youtube.videos.delete({ id: videoId });
    console.log("Deleted from YouTube:", videoId);
    res.json({ ok: true, deleted: videoId });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error("YouTube delete failed for", videoId, "->", msg);
    res.status(500).json({ error: msg });
  }
});

// ---- scheduled jobs: upload any that are due ----
let processing = false;
async function processDueJobs() {
  if (processing) return;
  processing = true;
  try {
    const now = Date.now();
    let listData = await readList();
    const due = listData.filter((v) => v && v.pendingUpload && !v.uploading && v.scheduledAt && new Date(v.scheduledAt).getTime() <= now);
    for (const job of due.slice(0, 3)) {
      // mark uploading so the next cron run won't pick it again
      listData = await readList();
      const i = listData.findIndex((x) => x.id === job.id);
      if (i < 0 || listData[i].uploading || !listData[i].pendingUpload) continue;
      listData[i].uploading = true;
      await writeList(listData);
      try {
        // Upload at the scheduled time with the chosen visibility (default Public = live now).
        // No publishAt: we are already uploading AT the scheduled time, so it goes live immediately.
        const finalStatus = job.publishStatus || "public";
        const result = await runTransfer({
          driveUrl: job.driveUrl, title: job.title, description: job.description,
          tags: job.tags, status: finalStatus,
        });
        listData = await readList();
        const j = listData.findIndex((x) => x.id === job.id);
        if (j >= 0) {
          listData[j] = {
            ...listData[j],
            videoId: result.videoId,
            videoUrl: "https://youtu.be/" + result.videoId,
            thumbnail: listData[j].thumbnail || "https://i.ytimg.com/vi/" + result.videoId + "/hqdefault.jpg",
            status: finalStatus.charAt(0).toUpperCase() + finalStatus.slice(1),
            pendingUpload: false, uploading: false, scheduledAt: null,
            uploadError: result.thumbError ? ("Thumbnail: " + result.thumbError) : null,
          };
          await writeList(listData);
        }
      } catch (e) {
        listData = await readList();
        const j = listData.findIndex((x) => x.id === job.id);
        if (j >= 0) { listData[j] = { ...listData[j], uploading: false, uploadError: (e && e.message ? e.message : String(e)) }; await writeList(listData); }
      }
    }
  } catch (e) {
    console.error("processDueJobs error:", e && e.message ? e.message : e);
  } finally {
    processing = false;
  }
}

app.get("/process-due", (req, res) => {
  res.json({ ok: true, started: true });
  processDueJobs().catch((e) => console.error(e));
});

app.get("/", (_req, res) => res.json({
  ok: true,
  service: "qht-drive-to-youtube",
  driveAuthorized: !!driveToken(),
  ytAuthorized: !!ytToken(),
  authorized: !!(driveToken() && ytToken()),
  kvConfigured: !!CF_DATA_URL,
}));

app.listen(PORT, () => console.log("Drive->YouTube server on port " + PORT));
