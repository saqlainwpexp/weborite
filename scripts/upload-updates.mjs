// Upload the auto-update files to the Hostinger "updates" folder that electron-updater reads
// (https://studio.weborite.com/updates/). Run after `npm run dist` has produced release/.
//
// Needs these environment variables (set as GitHub Actions secrets in the release workflow):
//   UPDATE_SFTP_HOST   e.g. 123.45.67.89  or  ftp.studio.weborite.com
//   UPDATE_SFTP_USER   the SFTP username
//   UPDATE_SFTP_PASS   the SFTP password
//   UPDATE_SFTP_PATH   absolute path to the web-served updates folder,
//                      e.g. /home/uXXXX/domains/studio.weborite.com/public_html/updates
//   UPDATE_SFTP_PORT   optional, defaults to 22
//
// It uploads latest.yml (the manifest electron-updater checks), the NSIS installer .exe, and the
// matching .blockmap (used for smaller delta downloads). Missing files are skipped with a warning.
import SftpClient from "ssh2-sftp-client";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { UPDATE_SFTP_HOST, UPDATE_SFTP_USER, UPDATE_SFTP_PASS, UPDATE_SFTP_PATH, UPDATE_SFTP_PORT } = process.env;
// Not configured yet (no host): skip without failing the release. The GitHub release still has the .exe.
if (!UPDATE_SFTP_HOST) {
  console.log("upload-updates: UPDATE_SFTP_* secrets not set — skipping update upload (auto-update feed not published).");
  process.exit(0);
}
// Host set but the rest missing is a real misconfiguration.
if (!UPDATE_SFTP_USER || !UPDATE_SFTP_PASS || !UPDATE_SFTP_PATH) {
  console.error("upload-updates: UPDATE_SFTP_HOST is set but UPDATE_SFTP_USER / UPDATE_SFTP_PASS / UPDATE_SFTP_PATH are missing.");
  process.exit(1);
}

const releaseDir = join(process.cwd(), "release");
if (!existsSync(releaseDir)) {
  console.error(`upload-updates: ${releaseDir} doesn't exist — run "npm run dist" first.`);
  process.exit(1);
}

// latest.yml plus every installer and blockmap electron-builder produced.
const files = readdirSync(releaseDir).filter((f) => f === "latest.yml" || f.endsWith(".exe") || f.endsWith(".exe.blockmap"));
if (!files.includes("latest.yml")) {
  console.error("upload-updates: release/latest.yml is missing — check that build.publish is set in package.json.");
  process.exit(1);
}

const remoteBase = UPDATE_SFTP_PATH.replace(/\/+$/, "");
const sftp = new SftpClient();
try {
  await sftp.connect({ host: UPDATE_SFTP_HOST, port: Number(UPDATE_SFTP_PORT) || 22, username: UPDATE_SFTP_USER, password: UPDATE_SFTP_PASS, readyTimeout: 30000 });
  if (!(await sftp.exists(remoteBase))) await sftp.mkdir(remoteBase, true);
  for (const f of files) {
    await sftp.put(join(releaseDir, f), `${remoteBase}/${f}`);
    console.log(`  • uploaded ${f}`);
  }
  console.log(`upload-updates: ${files.length} file(s) uploaded to ${remoteBase}`);
} finally {
  await sftp.end().catch(() => {});
}
