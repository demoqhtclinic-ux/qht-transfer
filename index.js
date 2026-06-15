// QHT Clinic - Drive -> YouTube transfer server (two-account version).
//
// Reads the Drive folder with ONE account and uploads to YouTube with ANOTHER,
// because the Drive files live on a @qhtclinic.com account while the YouTube
// channel lives on a personal gmail.
//
// POST /api/transfer  { driveUrl, title, description, tags, status }
// GET  /auth          -> sign in, GET /oauth2callback shows a refresh token.
//
// Env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//   GOOGLE_REFRESH_TOKEN_DRIVE   -> account that can read the Drive folder
//   GOOGLE_REFRESH_TOKEN_YT      -> account that owns the YouTube channel
//   GOOGLE_REFRESH_TOKEN         -> optional fallback used for both if the two above are missing
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

app.get("/auth", (_req, res) => {
  const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oauthClient().getToken(req.query.code);
    const rt = tokens.refresh_token;
    res.type("html").send(rt
      ? `<h2>Success</h2><p>Copy this refresh token. Use it as GOOGLE_REFRESH_TOKEN_DRIVE (Drive account) or GOOGLE_REFRESH_TOKEN_YT (YouTube account) on the server, then redeploy:</p><pre style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:12px">${rt}</pre>`
      : `<h2>No refresh token.</h2><p>Remove the app at myaccount.google.com/permissions, then open /auth again.</p>`);
  } catch (e) {
    res.status(500).send("Auth failed: " + (e && e.message ? e.message : String(e)));
  }
});

app.post("/api/transfer", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  if (!driveToken() || !ytToken()) return res.status(500).json({ error: "Server not authorized yet - set GOOGLE_REFRESH_TOKEN_DRIVE and GOOGLE_REFRESH_TOKEN_YT." });

  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-cache");
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };

  try {
    const drive = google.drive({ version: "v3", auth: clientFor(driveToken()) });
    const youtube = google.youtube({ version: "v3", auth: clientFor(ytToken()) });

    const folderId = driveIdFromLink(req.body.driveUrl);
    if (!folderId) { send({ error: "Could not read a folder id from that Drive link." }); return res.end(); }

    send({ stage: "listing", message: "Reading the Drive folder..." });
    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,size)",
      pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    const files = list.data.files || [];
    const video = files.find((f) => (f.mimeType || "").startsWith("video/") || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(f.name));
    const image = files.find((f) => (f.mimeType || "").startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name));
    if (!video) { send({ error: "No video file found in that folder. Files seen: " + files.map(f => f.name).join(", ") }); return res.end(); }
    send({ stage: "found", message: "Found " + video.name, video: video.name, image: image ? image.name : null });

    const videoStream = (await drive.files.get({ fileId: video.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })).data;
    const total = Number(video.size || 0);
    send({ stage: "uploading", message: "Uploading to YouTube...", total });

    const privacy = ["public", "unlisted", "private"].includes(String(req.body.status || "").toLowerCase()) ? String(req.body.status).toLowerCase() : "private";

    let lastPct = -1;
    const insert = await youtube.videos.insert(
      {
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title: req.body.title || video.name, description: req.body.description || "", tags: Array.isArray(req.body.tags) ? req.body.tags : [], categoryId: "22" },
          status: { privacyStatus: privacy },
        },
        media: { body: videoStream },
      },
      { onUploadProgress: (e) => { if (!total) return; const pct = Math.round((e.bytesRead / total) * 100); if (pct !== lastPct) { lastPct = pct; send({ stage: "progress", uploaded: e.bytesRead, total, pct }); } } }
    );

    const videoId = insert.data.id;
    send({ stage: "uploaded", message: "Video uploaded - processing...", videoId });

    if (image) {
      try {
        const imgStream = (await drive.files.get({ fileId: image.id, alt: "media", supportsAllDrives: true }, { responseType: "stream" })).data;
        await youtube.thumbnails.set({ videoId, media: { mimeType: image.mimeType || "image/jpeg", body: imgStream } });
        send({ stage: "thumbnail", message: "Thumbnail set" });
      } catch (e) {
        send({ stage: "thumbnail_failed", message: "Thumbnail failed (channel may need verification): " + (e && e.message ? e.message : e) });
      }
    }

    send({ stage: "done", videoId, title: req.body.title || video.name, privacy });
  } catch (e) {
    send({ error: e && e.message ? e.message : String(e) });
  } finally {
    res.end();
  }
});

app.get("/", (_req, res) => res.json({
  ok: true,
  service: "qht-drive-to-youtube",
  driveAuthorized: !!driveToken(),
  ytAuthorized: !!ytToken(),
  authorized: !!(driveToken() && ytToken()),
}));

app.listen(PORT, () => console.log("Drive->YouTube server on port " + PORT));
