// src/components/UploadButton.jsx (FRONTEND – DÁN VÀO ĐÂY)
import { useState } from 'react';

export default function UploadButton() {
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (file) => {
    if (!file) return;

    setUploading(true);
    try {
      // BƯỚC 1: Gọi API backend để lấy sessionUrl (resumable upload)
      const initRes = await fetch('/api/init-drive-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          filename: file.name,
          mimetype: file.type || 'application/octet-stream'
        })
      });

      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({}));
        throw new Error(err.details || err.error || 'Không thể khởi tạo upload');
      }

      const { sessionUrl } = await initRes.json();

      // BƯỚC 2: Upload từng chunk (resumable)
      const chunkSize = 1024 * 1024; // 1MB
      let start = 0;

      while (start < file.size) {
        const end = Math.min(start + chunkSize, file.size);
        const chunk = file.slice(start, end);

        const uploadRes = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Range': `bytes ${start}-${end - 1}/${file.size}`,
          },
          body: chunk,
        });

        if (uploadRes.status === 200 || uploadRes.status === 201) {
          alert('Upload thành công!');
          break;
        } else if (uploadRes.status !== 308) {
          throw new Error('Upload thất bại');
        }

        start = end;
      }
    } catch (err) {
      console.error('Upload error:', err.message);
      alert('Lỗi: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input
        type="file"
        onChange={(e) => handleUpload(e.target.files[0])}
        disabled={uploading}
      />
      {uploading && <p>Đang upload...</p>}
    </div>
  );
}