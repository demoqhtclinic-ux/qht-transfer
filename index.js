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

import "dotenv/config"; // loads variables from a local .env file (configurable on the server)
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
  HOST = "127.0.0.1", // bind to localhost only; nginx reverse-proxies to it (safe behind a proxy)
} = process.env;

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/drive.readonly",
];

const driveToken = () => GOOGLE_REFRESH_TOKEN_DRIVE || GOOGLE_REFRESH_TOKEN;

// ---- Multiple YouTube channels ----
// Channels come from two places:
//   1. Env vars  YT1_NAME / YT1_TOKEN, YT2_NAME / YT2_TOKEN, ... (up to 10).
//      Old single GOOGLE_REFRESH_TOKEN_YT still works as a fallback "Default channel".
//   2. Added at runtime from the dashboard's "Add a YouTube channel" button (the /auth flow).
//      Those are cached in memory and persisted to Cloudflare KV (when CF_DATA_URL is set) so
//      they survive restarts/redeploys — no env var editing needed.
const YT_CHANNELS = [];
for (let i = 1; i <= 10; i++) {
  const token = process.env["YT" + i + "_TOKEN"];
  if (token) YT_CHANNELS.push({ id: "yt" + i, name: process.env["YT" + i + "_NAME"] || ("Channel " + i), token });
}
if (!YT_CHANNELS.length && (GOOGLE_REFRESH_TOKEN_YT || GOOGLE_REFRESH_TOKEN)) {
  YT_CHANNELS.push({ id: "default", name: "Default channel", token: GOOGLE_REFRESH_TOKEN_YT || GOOGLE_REFRESH_TOKEN });
}

// Channels added at runtime via the dashboard. Stored as [{id, name, token}].
let dynamicChannels = [];
const channelsKvUrl = () => (CF_DATA_URL ? CF_DATA_URL.replace(/\/+$/, "") + "/channels" : "");
async function loadDynamicChannels() {
  if (!channelsKvUrl()) return;
  try {
    const r = await fetch(channelsKvUrl(), { headers: CF_DATA_KEY ? { "x-access-key": CF_DATA_KEY } : {} });
    if (r.ok) { const d = await r.json(); if (Array.isArray(d)) dynamicChannels = d; }
  } catch (e) { console.error("loadDynamicChannels:", e && e.message ? e.message : e); }
}
async function saveDynamicChannels() {
  if (!channelsKvUrl()) return; // CF not configured → in-memory only (lost on restart)
  await fetch(channelsKvUrl(), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(CF_DATA_KEY ? { "x-access-key": CF_DATA_KEY } : {}) },
    body: JSON.stringify(dynamicChannels),
  });
}

function allChannels() { return [...YT_CHANNELS, ...dynamicChannels]; }
function ytChannelBy(id) { const all = allChannels(); return all.find((c) => c.id === id) || all[0]; }
function ytTokenFor(id) { const c = ytChannelBy(id); return c ? c.token : (GOOGLE_REFRESH_TOKEN_YT || GOOGLE_REFRESH_TOKEN); }
const ytToken = () => ytTokenFor();

const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
  const ch = ytChannelBy(job.channel);
  const youtube = google.youtube({ version: "v3", auth: clientFor(ytTokenFor(job.channel)) });

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
  return { videoId, privacy, title: job.title || video.name, thumbnailSet, thumbError, channelName: ch ? ch.name : "", channel: ch ? ch.id : "" };
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
// /auth          -> legacy: shows the refresh token to copy into an env var (README Part C).
// /auth?add=1    -> dashboard "Add channel" flow: auto-registers the signed-in channel.
//                   Optional &name=<label> overrides the auto-detected channel title.
app.get("/auth", (req, res) => {
  const state = JSON.stringify({ add: req.query.add === "1", name: req.query.name ? String(req.query.name) : "" });
  const url = oauthClient().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
  res.redirect(url);
});
app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oauthClient().getToken(req.query.code);
    const rt = tokens.refresh_token;
    let st = {};
    try { st = JSON.parse(req.query.state || "{}"); } catch {}

    if (!rt) {
      return res.type("html").send(`<h2>No refresh token.</h2><p>Remove the app at myaccount.google.com/permissions, then open /auth again.</p>`);
    }

    // Legacy flow (opened /auth directly): show the token for manual env setup.
    if (!st.add) {
      return res.type("html").send(`<h2>Success</h2><p>Copy this refresh token (use as GOOGLE_REFRESH_TOKEN_DRIVE or GOOGLE_REFRESH_TOKEN_YT), then redeploy:</p><pre style="white-space:pre-wrap;word-break:break-all;background:#eee;padding:12px">${escapeHtml(rt)}</pre>`);
    }

    // Dashboard "Add channel" flow: detect which channel this account owns and register it.
    let channelName = st.name || "", channelId = "";
    try {
      const yt = google.youtube({ version: "v3", auth: clientFor(rt) });
      const me = await yt.channels.list({ part: ["snippet"], mine: true });
      const mine = me.data.items && me.data.items[0];
      if (mine) { channelId = mine.id; if (!channelName) channelName = mine.snippet && mine.snippet.title; }
    } catch (e) { console.error("channels.list(mine) failed:", e && e.message ? e.message : e); }

    const id = channelId || ("ch_" + Date.now().toString(36));
    await loadDynamicChannels();
    dynamicChannels = dynamicChannels.filter((c) => c.id !== id); // replace if this channel was added before
    dynamicChannels.push({ id, name: channelName || ("Channel " + (allChannels().length + 1)), token: rt });
    let persisted = true;
    try { await saveDynamicChannels(); persisted = !!channelsKvUrl(); }
    catch (e) { persisted = false; console.error("saveDynamicChannels:", e && e.message ? e.message : e); }

    res.type("html").send(
      `<div style="font-family:system-ui,Segoe UI,Arial;max-width:560px;margin:60px auto;text-align:center;line-height:1.6">
         <h2 style="color:#0e8c7e;margin-bottom:6px">&#10003; Channel added</h2>
         <p><b>${escapeHtml(channelName || id)}</b> is now available in the dashboard's channel dropdown.</p>
         ${persisted ? "" : `<p style="color:#b45309">Note: this channel is kept in memory only (CF_DATA_URL not set, or save failed), so it may be lost if the server restarts.</p>`}
         <p style="color:#555">You can close this tab and go back to the dashboard.</p>
       </div>`
    );
  } catch (e) {
    res.status(500).send("Auth failed: " + (e && e.message ? e.message : String(e)));
  }
});

// ---- immediate upload (streams progress) ----
app.post("/api/transfer", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  await loadDynamicChannels(); // make sure dashboard-added channels are known before we pick a token
  if (!driveToken() || !ytToken()) return res.status(500).json({ error: "Server not authorized yet - set GOOGLE_REFRESH_TOKEN_DRIVE and GOOGLE_REFRESH_TOKEN_YT." });

  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-cache");
  const send = (o) => { try { res.write(JSON.stringify(o) + "\n"); } catch {} };

  try {
    send({ stage: "listing", message: "Reading the Drive folder..." });
    const result = await runTransfer(req.body, send);
    send({ stage: "done", videoId: result.videoId, title: result.title, privacy: result.privacy, channelName: result.channelName, channel: result.channel });
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
    await loadDynamicChannels();
    const youtube = google.youtube({ version: "v3", auth: clientFor(ytTokenFor(req.body.channel)) });
    await youtube.videos.delete({ id: videoId });
    console.log("Deleted from YouTube:", videoId);
    res.json({ ok: true, deleted: videoId });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error("YouTube delete failed for", videoId, "->", msg);
    res.status(500).json({ error: msg });
  }
});

// ---- edit an already-uploaded YouTube video (title / description / tags / privacy) ----
app.post("/api/update", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  const { videoId, channel, title, description, tags, status } = req.body || {};
  if (!videoId) return res.status(400).json({ error: "videoId required" });
  try {
    await loadDynamicChannels();
    const youtube = google.youtube({ version: "v3", auth: clientFor(ytTokenFor(channel)) });

    // YouTube's videos.update REPLACES the snippet, so read the current one first and
    // merge our changes onto it (this keeps categoryId etc. and avoids wiping fields).
    const cur = await youtube.videos.list({ part: "snippet,status", id: videoId });
    const item = cur.data.items && cur.data.items[0];
    if (!item) return res.status(404).json({ error: "Video not found on this channel — is the right channel selected?" });
    const snip = item.snippet || {};

    const snippet = {
      categoryId: snip.categoryId || "22",
      title: (title != null && String(title).trim() !== "" ? title : snip.title) || "Untitled",
      description: description != null ? description : (snip.description || ""),
      tags: Array.isArray(tags) ? tags : (snip.tags || []),
    };
    const requestBody = { id: videoId, snippet };
    let part = "snippet";

    // Optional privacy change (Public / Private / Unlisted). "Scheduled" is ignored here.
    const privacyMap = { Public: "public", Private: "private", Unlisted: "unlisted" };
    if (status && privacyMap[status]) {
      const st = item.status || {};
      requestBody.status = { privacyStatus: privacyMap[status], selfDeclaredMadeForKids: st.selfDeclaredMadeForKids || false };
      part = "snippet,status";
    }

    await youtube.videos.update({ part, requestBody });
    console.log("Updated on YouTube:", videoId, "(tags:", snippet.tags.length, ")");
    res.json({ ok: true, updated: videoId, tags: snippet.tags.length });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.error("YouTube update failed for", videoId, "->", msg);
    res.status(500).json({ error: msg });
  }
});

// ---- scheduled jobs: upload any that are due ----
let processing = false;
async function processDueJobs() {
  if (processing) return;
  processing = true;
  try {
    await loadDynamicChannels();
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
          tags: job.tags, status: finalStatus, channel: job.channel,
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
            channelName: result.channelName || listData[j].channelName || "",
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

// List the configured YouTube channels (id + name only, no tokens) for the dashboard dropdown.
app.get("/channels", async (_req, res) => {
  await loadDynamicChannels(); // pick up channels added on another instance / since startup
  // Env-var channels can't be removed from the dashboard; mark them so the UI hides the X.
  const envIds = new Set(YT_CHANNELS.map((c) => c.id));
  res.json(allChannels().map((c) => ({ id: c.id, name: c.name, removable: !envIds.has(c.id) })));
});

// Remove a dashboard-added channel from the list (does NOT touch the YouTube channel itself).
app.post("/channels/delete", async (req, res) => {
  if (ACCESS_KEY && req.headers["x-access-key"] !== ACCESS_KEY) return res.status(401).json({ error: "unauthorized" });
  const id = req.body && req.body.id;
  if (!id) return res.status(400).json({ error: "id required" });
  if (YT_CHANNELS.some((c) => c.id === id)) {
    return res.status(400).json({ error: "This channel is set via env vars and can't be removed from the dashboard." });
  }
  await loadDynamicChannels();
  const before = dynamicChannels.length;
  dynamicChannels = dynamicChannels.filter((c) => c.id !== id);
  if (dynamicChannels.length === before) return res.status(404).json({ error: "channel not found" });
  try { await saveDynamicChannels(); } catch (e) { return res.status(500).json({ error: "save failed: " + (e && e.message ? e.message : e) }); }
  console.log("Channel removed:", id);
  res.json({ ok: true });
});

app.get("/", async (_req, res) => {
  await loadDynamicChannels();
  res.json({
    ok: true,
    service: "qht-drive-to-youtube",
    driveAuthorized: !!driveToken(),
    ytAuthorized: !!ytToken(),
    authorized: !!(driveToken() && ytToken()),
    kvConfigured: !!CF_DATA_URL,
    channels: allChannels().map((c) => c.name),
  });
});

app.listen(PORT, HOST, () => {
  console.log("Drive->YouTube server on " + HOST + ":" + PORT);
  loadDynamicChannels().then(() => {
    const n = allChannels().length;
    if (n) console.log("Channels available: " + allChannels().map((c) => c.name).join(", "));
  });
});
