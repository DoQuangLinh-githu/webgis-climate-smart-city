// drive-multi.js
const { google } = require('googleapis');

async function uploadToNextDrive(buffer, filename, mimetype = 'application/octet-stream') {
  const key = JSON.parse(process.env.GMAIL_1_KEY);
  const folderId = process.env.GMAIL_1_FOLDER;

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });
  const fileMetadata = { name: filename, parents: [folderId] };
  const media = { mimeType: mimetype, body: buffer };

  const res = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, webViewLink',
  });

  return `https://drive.google.com/file/d/${res.data.id}/view`;
}

module.exports = { uploadToNextDrive };