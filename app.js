require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const path = require('path');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieParser());

// Kết nối PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.connect()
  .then(() => console.log(`Connected to PostgreSQL (${process.env.DB_NAME}) with user ${process.env.DB_USER}`))
  .catch(err => {
    console.error('PostgreSQL connection error:', {
      message: err.message,
      code: err.code,
      user: process.env.DB_USER,
      host: process.env.DB_HOST,
      database: process.env.DB_NAME
    });
    process.exit(1);
  });

// Middleware xác thực
function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  console.log('Token received:', token ? 'Yes' : 'No');
  if (!token) {
    console.log('No token provided, redirecting to /login');
    return res.redirect('/login?error=No token provided');
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Invalid token:', err.message);
      return res.redirect('/login?error=Invalid token');
    }
    req.user = user;
    pool.query('SELECT is_verified FROM users WHERE username = $1', [user.username], (err, result) => {
      if (err) {
        if (err.code === '42703') {
          console.warn('Column is_verified not found, assuming verified for now');
          next();
        } else {
          console.error('Database error checking is_verified:', err);
          return res.redirect('/login?error=Server error');
        }
      } else if (!result.rows[0] || !result.rows[0].is_verified) {
        console.log('Account not verified for:', user.username);
        res.clearCookie('token');
        return res.redirect('/login?error=Tài khoản chưa được xác nhận');
      }
      console.log('User authenticated:', user.username);
      next();
    });
  });
}

// Middleware kiểm tra vai trò
function checkRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      console.log(`Access denied: User role (${req.user?.role}) does not match required role (${role})`);
      return res.redirect('/dashboard');
    }
    next();
  };
}

// Hàm lấy GeoJSON từ GeoServer
async function getGeoJSON() {
  try {
    const response = await axios.get(process.env.GEOSERVER_URL);
    return response.data;
  } catch (err) {
    console.error('Error fetching GeoJSON from GeoServer:', err);
    return null;
  }
}

// Routes
app.get('/', async (req, res) => {
  const geojson = await getGeoJSON();
  res.render('index', { geojson, error: null, data: [], user: null });
});

app.get('/login', (req, res) => {
  res.render('login', { error: req.query.error });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('Login attempt for:', username);
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const user = result.rows[0];
  if (!user) {
    console.log('User not found:', username);
    return res.render('login', { error: 'Tên người dùng không tồn tại' });
  }
  if (!bcrypt.compareSync(password, user.password)) {
    console.log('Incorrect password for:', username);
    return res.render('login', { error: 'Mật khẩu không đúng' });
  }
  if (!user.is_verified) {
    console.log('Account not verified for:', username);
    return res.render('login', { error: 'Tài khoản chưa được xác minh!' });
  }
  const token = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.cookie('token', token, { httpOnly: true, maxAge: 3600000 });
  console.log('Login successful, redirecting to /dashboard');
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  res.render('register', { error: null, success: null });
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  console.log('Register attempt:', { username, email });
  try {
    if (!username || !email || !password) {
      return res.render('register', { error: 'Tất cả các trường (tên người dùng, email, mật khẩu) đều phải được điền', success: null });
    }
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.render('register', { error: 'Mật khẩu phải có ít nhất 8 ký tự, bao gồm chữ hoa, chữ thường, số, và ký tự đặc biệt!', success: null });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationCode = Math.random().toString().substring(2, 8);
    await pool.query(
      'INSERT INTO users (username, password, email, verification_code, is_verified, role) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, hashedPassword, email, verificationCode, false, 'user']
    );

    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'Xác nhận email cho WebGIS Climate Smart City',
      text: `Chào ${username},\n\nVui lòng sử dụng mã xác nhận sau để kích hoạt tài khoản của bạn:\n${verificationCode}\n\nTruy cập: ${process.env.APP_URL}/verify?email=${encodeURIComponent(email)}&code=${verificationCode}\n\nTrân trọng,\nĐội ngũ WebGIS`
    };
    await transporter.sendMail(mailOptions);

    res.render('register', { error: null, success: 'Đăng ký thành công! Vui lòng kiểm tra email để xác nhận.' });
  } catch (err) {
    console.error('Error registering user:', err);
    if (err.code === '23505') {
      res.render('register', { error: 'Tên người dùng hoặc email đã tồn tại!', success: null });
    } else {
      res.render('register', { error: 'Lỗi khi đăng ký. Vui lòng thử lại!', success: null });
    }
  }
});

app.get('/verify', async (req, res) => {
  const { email, code } = req.query;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1 AND verification_code = $2 AND NOT is_verified', [email, code]);
    if (result.rows.length > 0) {
      await pool.query('UPDATE users SET is_verified = TRUE, verification_code = NULL WHERE email = $1', [email]);
      res.send('Xác nhận email thành công! Bạn có thể đăng nhập tại <a href="/login">đây</a>.');
    } else {
      res.send('Mã xác nhận không hợp lệ hoặc email đã được xác nhận. Vui lòng kiểm tra lại hoặc liên hệ hỗ trợ.');
    }
  } catch (err) {
    console.error('Error verifying email:', err);
    res.send('Lỗi khi xác nhận email. Vui lòng thử lại sau.');
  }
});

app.get('/dashboard', authenticateToken, async (req, res) => {
  const user = req.user;
  const result = await pool.query('SELECT id, district, climate_index, smart_city_score, ST_X(geom::geometry) AS lng, ST_Y(geom::geometry) AS lat, ST_AsGeoJSON(geom) AS geom FROM data');
  const geojson = await getGeoJSON();
  res.render('dashboard', { user, error: null, data: result.rows, geojson });
});

app.get('/cndl', authenticateToken, async (req, res) => {
  const user = req.user;
  const geojson = await getGeoJSON();
  res.render('cndl', { user, error: null, geojson });
});

app.post('/cndl', authenticateToken, async (req, res) => {
  const user = req.user;
  const { district, climateIndex, smartCityScore, lat, lng } = req.body;
  try {
    await pool.query(
      'INSERT INTO data (district, climate_index, smart_city_score, geom) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))',
      [district, climateIndex, smartCityScore, lng, lat]
    );
    res.redirect('/dashboard');
  } catch (err) {
    res.render('cndl', { user, error: 'Lỗi khi cập nhật dữ liệu!' });
  }
});

app.get('/history', authenticateToken, async (req, res) => {
  const user = req.user;
  const result = await pool.query('SELECT district, climate_index, smart_city_score FROM data ORDER BY id DESC LIMIT 10');
  res.render('history', { user, error: null, data: result.rows });
});

app.get('/changepass', authenticateToken, (req, res) => {
  const user = req.user;
  res.render('changepass', { user, error: null });
});

app.post('/changepass', authenticateToken, async (req, res) => {
  const user = req.user;
  const { oldPassword, newPassword } = req.body;
  try {
    const result = await pool.query('SELECT password FROM users WHERE username = $1', [user.username]);
    const storedPassword = result.rows[0].password;
    if (!bcrypt.compareSync(oldPassword, storedPassword)) {
      return res.render('changepass', { user, error: 'Mật khẩu cũ không đúng!' });
    }
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedNewPassword, user.username]);
    res.render('changepass', { user, error: 'Đổi mật khẩu thành công!' });
  } catch (err) {
    res.render('changepass', { user, error: 'Đã xảy ra lỗi! Vui lòng thử lại.' });
  }
});

app.get('/hsnd', authenticateToken, checkRole('admin'), async (req, res) => {
  const user = req.user;
  const result = await pool.query('SELECT username, role FROM users');
  res.render('hsnd', { user, error: null, users: result.rows });
});

app.post('/hsnd/update-role', authenticateToken, checkRole('admin'), async (req, res) => {
  const { username, role } = req.body;
  try {
    await pool.query('UPDATE users SET role = $1 WHERE username = $2', [role, username]);
    res.redirect('/hsnd');
  } catch (err) {
    res.render('hsnd', { user: req.user, error: 'Lỗi khi cập nhật vai trò!', users: [] });
  }
});

app.get('/qldl', authenticateToken, checkRole('admin'), async (req, res) => {
  const user = req.user;
  const result = await pool.query('SELECT id, district, climate_index, smart_city_score FROM data');
  const geojson = await getGeoJSON();
  res.render('qldl', { user, error: null, data: result.rows, geojson });
});

app.post('/qldl', authenticateToken, checkRole('admin'), async (req, res) => {
  const user = req.user;
  const { district, climateIndex, smartCityScore, lat, lng } = req.body;
  try {
    await pool.query(
      'INSERT INTO data (district, climate_index, smart_city_score, geom) VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326))',
      [district, climateIndex, smartCityScore, lng, lat]
    );
    res.redirect('/qldl');
  } catch (err) {
    res.render('qldl', { user, error: 'Lỗi khi thêm dữ liệu!' });
  }
});

app.get('/xbtk', authenticateToken, checkRole('admin'), async (req, res) => {
  const user = req.user;
  res.render('xbtk', { user, error: null });
});

app.get('/export/pdf', authenticateToken, checkRole('admin'), async (req, res) => {
  const result = await pool.query('SELECT id, district, climate_index, smart_city_score FROM data');
  const data = result.rows;

  const doc = new PDFDocument({ size: 'A4', bufferPages: true });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="report.pdf"');
  doc.pipe(res);

  doc.registerFont('TimesNewRoman', path.join(__dirname, 'public', 'fonts', 'Times New Roman.ttf'));
  doc.font('TimesNewRoman').fontSize(20).text('Báo cáo Dữ Liệu Thành Phố Thông Minh', { align: 'center' });
  doc.moveDown();

  doc.font('TimesNewRoman').fontSize(12).text('Danh sách dữ liệu:', { underline: true });
  doc.moveDown();
  data.forEach((item, index) => {
    doc.text(`ID: ${item.id}, Quận/Huyện: ${item.district}, Chỉ số khí hậu: ${item.climate_index}, Điểm TP Thông minh: ${item.smart_city_score}`);
    if (index < data.length - 1) doc.moveDown();
  });

  doc.end();
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/');
});

app.get('/sua_bdkh/:id', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT id, district, climate_index, smart_city_score, ST_X(geom) AS lng, ST_Y(geom) AS lat FROM data WHERE id = $1', [req.params.id]);
  const item = result.rows[0];
  const geojson = await getGeoJSON();
  res.render('sua_bdkh', { item, geojson, user: req.user, error: null });
});

app.post('/sua_bdkh/:id', authenticateToken, async (req, res) => {
  const { district, climateIndex, smartCityScore, lat, lng } = req.body;
  await pool.query(
    'UPDATE data SET district = $1, climate_index = $2, smart_city_score = $3, geom = ST_SetSRID(ST_MakePoint($4, $5), 4326) WHERE id = $6',
    [district, climateIndex, smartCityScore, lng, lat, req.params.id]
  );
  res.redirect('/dashboard');
});

module.exports = app;