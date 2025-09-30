require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const cookieParser = require('cookie-parser');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const multer = require('multer');
const fs = require('fs').promises;
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
// ❌ Bỏ Redis
// const Redis = require('ioredis');
const nodemailer = require('nodemailer');
const math = require('mathjs');

console.log('🚀 Khởi động hệ thống WebGIS Climate Smart City...');

// Express app
const app = express();

// 🚫 Không dùng Redis
console.warn("⚠️ Redis đã được tắt, hệ thống chỉ sử dụng PostgreSQL.");

// ==== Evaluate Formula ====
function evaluateFormula(formula, value, additionalParams = {}) {
  try {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) throw new Error('Giá trị không hợp lệ để tính công thức');

    if (formula.includes('value *')) {
      const multiplier = parseFloat(formula.split('value *')[1].trim());
      if (isNaN(multiplier)) throw new Error('Hệ số nhân không hợp lệ');
      return numValue * multiplier;
    } else if (formula.includes('100 - value')) {
      return 100 - numValue;
    } else if (
      [
        'Qualitative/score by policy',
        'Scale 1-5',
        'Data availability & integration',
        'Existence and quality of plan',
        'Composite',
        'Count density',
        'Number of days AQI > threshold',
        'Digitalization level',
        'Number/quality of initiatives',
        'Operational efficiency',
        'GHG reduction measures',
        'Level of service',
      ].includes(formula)
    ) {
      return numValue;
    } else if (formula.includes('avg(')) {
      const params = formula.match(/avg\(([^)]+)\)/)[1].split(',').map((p) => p.trim());
      const values = params.map((param) => additionalParams[param] || numValue);
      if (values.some((v) => isNaN(parseFloat(v)))) throw new Error('Tham số không hợp lệ cho hàm avg');
      return values.reduce((sum, val) => sum + parseFloat(val), 0) / values.length;
    } else {
      let evalFormula = formula;
      for (const [key, val] of Object.entries(additionalParams)) {
        evalFormula = evalFormula.replace(new RegExp(key, 'g'), val);
      }
      evalFormula = evalFormula.replace('value', numValue.toString());

      const result = math.evaluate(evalFormula);
      if (typeof result !== 'number' || isNaN(result)) throw new Error('Kết quả công thức không hợp lệ');
      return result;
    }
  } catch (err) {
    console.error(`Lỗi xử lý công thức "${formula}":`, err.message);
    return parseFloat(value) || 0;
  }
}

// ==== View Engine ====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==== Security Headers ====
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com'],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'https://unpkg.com'],
        imgSrc: ["'self'", 'data:', 'https://*'],
        fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
      },
    },
  })
);

// ==== CORS ====
app.use(
  cors({
    origin: process.env.NODE_ENV === 'production' ? process.env.APP_URL : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

// ==== Rate Limit ====
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100;

app.use(
  rateLimit({
    windowMs,
    max: maxRequests,
    message: {
      error: 'Quá nhiều yêu cầu từ IP này. Vui lòng thử lại sau.',
      retryAfter: Math.ceil(windowMs / 1000),
    },
    handler: (req, res) => {
      res.status(429).json({
        error: 'Vượt quá giới hạn yêu cầu',
        retryAfter: Math.ceil(windowMs / 1000),
      });
    },
  })
);

// ==== Body Parser & Cookies ====
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(process.env.SESSION_SECRET));

// ==== Static Files ====
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
  })
);

// ==== Uploads Directory ====
const uploadDir = process.env.UPLOAD_DIR || '/tmp/uploads';
(async () => {
  try {
    await fs.mkdir(uploadDir, { recursive: true });
    console.log(`📁 Đã tạo thư mục uploads: ${uploadDir}`);
  } catch (err) {
    console.error('❌ Lỗi khi tạo thư mục uploads:', err);
  }
})();

const upload = multer({
  dest: uploadDir,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Chỉ chấp nhận file PDF!'), false);
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ==== PostgreSQL (Neon) ====
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .query('SELECT NOW()')
  .then(() => console.log('✅ Connected to Neon PostgreSQL'))
  .catch((err) => {
    console.error('❌ PostgreSQL connection error:', { message: err.message, code: err.code });
    process.exit(1);
  });

// ==== Constraints ====
async function ensureConstraints() {
  try {
    await pool.query(`
      ALTER TABLE Assessments_Template
      ADD CONSTRAINT unique_city_year_indicator UNIQUE (city, year, indicator_code);
    `);
    console.log('✅ Đã thêm ràng buộc unique cho Assessments_Template');
  } catch (err) {
    if (err.code !== '42710') {
      console.error('❌ Lỗi khi thêm ràng buộc unique:', err.message);
    } else {
      console.log('✅ Ràng buộc unique đã tồn tại cho Assessments_Template');
    }
  }
}

// ==== Parse Range ====
function parseRange(criteria) {
  try {
    if (!criteria || criteria === '0') return { min_value: null, max_value: null };

    const cleanCriteria = criteria.trim().replace(/%/g, '').replace(/m²\/người/g, '');

    if (!cleanCriteria.match(/[\d<=>-]/)) return { min_value: null, max_value: null };

    if (cleanCriteria.startsWith('<')) {
      const max = parseFloat(cleanCriteria.replace('<', ''));
      return { min_value: null, max_value: max };
    } else if (cleanCriteria.startsWith('≥') || cleanCriteria.startsWith('>=')) {
      const min = parseFloat(cleanCriteria.replace('≥', '').replace('>=', ''));
      return { min_value: min, max_value: null };
    } else if (cleanCriteria.includes('-')) {
      const [min, max] = cleanCriteria.split('-').map((s) => s.trim());
      let minVal = min.includes('>') ? parseFloat(min.replace('>', '')) : parseFloat(min);
      let maxVal = max.includes('<') ? parseFloat(max.replace('<', '')) : parseFloat(max);
      return { min_value: minVal, max_value: maxVal };
    } else {
      const value = parseFloat(cleanCriteria);
      if (!isNaN(value)) return { min_value: value, max_value: value };
      return { min_value: null, max_value: null };
    }
  } catch (err) {
    console.warn(`⚠️ Không thể parse phạm vi từ "${criteria}": ${err.message}`);
    return { min_value: null, max_value: null };
  }
}

// ==== getCachedOrQuery (chỉ dùng PostgreSQL) ====
async function getCachedOrQuery(key, query) {
  try {
    const result = await pool.query(query);
    console.log(`✅ Lấy dữ liệu trực tiếp từ PostgreSQL cho key: ${key}`);
    return result.rows;
  } catch (err) {
    console.error(`❌ Lỗi khi query PostgreSQL cho key ${key}:`, err.message);
    return [];
  }
}

// Khởi tạo cơ sở dữ liệu
let dbInitialized = false;
async function initializeDatabase() {
  if (dbInitialized) return;

  try {
    console.log('🛠️ Khởi tạo cấu trúc cơ sở dữ liệu...');

    // Xóa các bảng theo thứ tự ngược với phụ thuộc, bao gồm các bảng phụ thuộc
    await pool.query(`
      DROP TABLE IF EXISTS Assessments_Template CASCADE;
      DROP TABLE IF EXISTS IndicatorWeights CASCADE;
      DROP TABLE IF EXISTS ScoringLevels CASCADE;
      DROP TABLE IF EXISTS Levels CASCADE;
      DROP TABLE IF EXISTS Inputs CASCADE;
      DROP TABLE IF EXISTS District_Indicators CASCADE;
      DROP TABLE IF EXISTS Indicators CASCADE;
      DROP TABLE IF EXISTS DomainWeights CASCADE;
      DROP TABLE IF EXISTS Domains CASCADE;
      DROP TABLE IF EXISTS Units CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS edit_history CASCADE;
      DROP TABLE IF EXISTS file_uploads CASCADE;
    `);

    // Tạo các bảng theo đúng thứ tự
    // Bảng: Units
    await pool.query(`
      CREATE TABLE Units (
        unit_code VARCHAR(50) PRIMARY KEY,
        description TEXT
      );
    `);

    // Bảng: Domains
    await pool.query(`
      CREATE TABLE Domains (
        domain_id INTEGER PRIMARY KEY,
        name TEXT,
        description TEXT,
        max_score INTEGER
      );
    `);

    // Bảng: Indicators
    await pool.query(`
      CREATE TABLE Indicators (
        indicator_id INTEGER PRIMARY KEY,
        domain_id INTEGER REFERENCES Domains(domain_id),
        name TEXT,
        code VARCHAR(50),
        max_score INTEGER,
        unit_code VARCHAR(50) REFERENCES Units(unit_code),
        formula TEXT
      );
    `);

    // Bảng: ScoringLevels
    await pool.query(`
      CREATE TABLE ScoringLevels (
        indicator_id INTEGER,
        indicator_code VARCHAR(50),
        level INTEGER,
        description TEXT,
        score_value INTEGER,
        PRIMARY KEY (indicator_id, level),
        FOREIGN KEY (indicator_id) REFERENCES Indicators(indicator_id)
      );
    `);

    // Bảng: DomainWeights
    await pool.query(`
      CREATE TABLE DomainWeights (
        item_type TEXT,
        domain_id INTEGER REFERENCES Domains(domain_id),
        item_code TEXT,
        weight NUMERIC
      );
    `);

    // Bảng: IndicatorWeights
    await pool.query(`
      CREATE TABLE IndicatorWeights (
        indicator_id INTEGER REFERENCES Indicators(indicator_id),
        indicator_code VARCHAR(50),
        domain_id INTEGER REFERENCES Domains(domain_id),
        weight_within_domain NUMERIC
      );
    `);

// Trong hàm initializeDatabase, cập nhật tạo bảng Assessments_Template
await pool.query(`
  CREATE TABLE Assessments_Template (
    assessment_id SERIAL PRIMARY KEY,
    city TEXT,
    year INTEGER,
    domain_id INTEGER REFERENCES Domains(domain_id),
    indicator_id INTEGER REFERENCES Indicators(indicator_id),
    indicator_code VARCHAR(50),
    value TEXT,
    unit_code VARCHAR(50) REFERENCES Units(unit_code),
    score_awarded INTEGER,
    assessor TEXT,
    date DATE,
    level INTEGER,
    description TEXT,
    CONSTRAINT unique_city_year_indicator UNIQUE (city, year, indicator_code)
  );
`);

await pool.query(`
  CREATE TABLE users (
    username VARCHAR(50) PRIMARY KEY,
    password TEXT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user'
  );
`);

await pool.query(`
  CREATE TABLE edit_history (
    id SERIAL PRIMARY KEY,
    table_name TEXT,
    record_id TEXT,
    old_values JSONB,
    new_values JSONB,
    changed_by TEXT,
    change_type TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address TEXT,
    user_agent TEXT
  );
`);

await pool.query(`
  CREATE TABLE file_uploads (
    id SERIAL PRIMARY KEY,
    filename TEXT,
    original_name TEXT,
    mimetype TEXT,
    size INTEGER,
    uploaded_by TEXT,
    file_path TEXT,
    upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

    // TRUNCATE tất cả các bảng để xóa dữ liệu cũ và reset identity
    await pool.query(`
      TRUNCATE TABLE Assessments_Template, IndicatorWeights, ScoringLevels, Indicators, DomainWeights, Domains, Units, users, edit_history, file_uploads RESTART IDENTITY;
    `);

    // Chèn dữ liệu vào bảng Units
    await pool.query(`
      INSERT INTO Units (unit_code, description) VALUES
      ('percent', 'Phần trăm (%)'),
      ('m2/person', 'm2 trên 1 người'),
      ('tCO2e/year', 'tCO2 tương đương / năm'),
      ('tCO2e/GDP', 'tCO2 tương đương trên đơn vị GDP'),
      ('days', 'Số ngày'),
      ('score', 'Điểm/scale (qualitative)'),
      ('count', 'Số lượng (count)'),
      ('kWh or percent', 'kWh hoặc phần trăm'),
      ('percent or count', 'Phần trăm hoặc số lượng'),
      ('percent or area', 'Phần trăm hoặc diện tích'),
      ('vehicles per 1000 or score', 'Số phương tiện trên 1000 người hoặc điểm'),
      ('stations per area', 'Số trạm trên đơn vị diện tích'),
      ('percent or ton', 'Phần trăm hoặc tấn');
    `);

    // Chèn dữ liệu vào bảng Domains
    await pool.query(`
      INSERT INTO Domains (domain_id, name, description, max_score) VALUES
      (1, 'Năng lượng & Công trình xanh', 'Các chỉ số về năng lượng tái tạo, tiết kiệm năng lượng và công trình xanh', 800),
      (2, 'Quy hoạch đô thị, phủ xanh & đa dạng sinh học', 'Chỉ số về phủ xanh, mặt nước, GIS, cảnh báo thiên tai, kế hoạch khí hậu', 700),
      (3, 'Giao thông đô thị & chất lượng không khí', 'Chỉ số giao thông, quan trắc không khí, AQI, kế hoạch không khí sạch', 1000),
      (4, 'Quản lý nước', 'Chỉ số quản lý tài nguyên nước, giảm thất thoát, tái sử dụng, cấp nước tiết kiệm', 800),
      (5, 'Quản lý chất thải', 'Chỉ số giảm thiểu chất thải, tái chế, bãi chôn lấp, phát thải GHG từ rác', 800);
    `);

    // Chèn dữ liệu vào bảng Indicators
    await pool.query(`
      INSERT INTO Indicators (indicator_id, domain_id, name, code, max_score, unit_code, formula) VALUES
      (1, 1, 'Tiêu thụ điện từ các nguồn năng lượng tái tạo', 'ENIRE', 15, 'percent', 'ENIRE = E_RE / EC *100'),
      (2, 1, 'Năng lượng tái tạo trong tổng nguồn cung năng lượng sơ cấp', 'SENIRE', 15, 'percent', 'SENIRE = SE_RE / ES *100'),
      (3, 1, 'Giảm phát thải CO2 từ tiêu thụ nhiên liệu hóa thạch', 'CO2red', 15, 'tCO2e/GDP', 'see document formula'),
      (4, 1, 'Chỉ số tiết kiệm điện', 'EIsave', 10, 'kWh or percent', 'EIsave = E_save / E_C *100'),
      (5, 1, 'Hiệu quả vận hành hệ thống điện thông minh', 'EILR', 10, 'percent', 'EILR = (E_input - E_delivered)/E_input losses'),
      (6, 1, 'Hệ thống chiếu sáng đường phố tiết kiệm năng lượng', 'SLI', 10, 'percent or count', 'SLI = (SL_e + SL_s)/SL *100'),
      (7, 1, 'Mức độ thúc đẩy các công trình xanh', 'GBpromo', 10, 'score', 'Qualitative/score by policy'),
      (8, 1, 'Xây dựng các công trình xanh', 'GBI', 15, 'percent or area', 'GBI = S_GB / S_BC *100'),
      (9, 2, 'Mức độ quy hoạch, bảo vệ và phát triển mặt nước & không gian mở', 'RS-water', 15, 'percent', 'avg(RS-water, R_so-op)'),
      (10, 2, 'Tỷ lệ phủ xanh trong thành phố (m²/người)', 'Rcover', 15, 'm2/person', 'Rcover = S_pp / P'),
      (11, 2, 'Tỷ lệ đất cây xanh đô thị trên tổng diện tích đất xây dựng đô thị', 'Rland-p', 15, 'percent', 'Rland-p = S_land-p / S_total-land *100'),
      (12, 2, 'Đa dạng sinh học đô thị', 'Biodiv', 15, 'score', 'Qualitative scale'),
      (13, 2, 'Ứng dụng GIS và dữ liệu số trong quy hoạch đô thị', 'GISapp', 10, 'score', 'Scale 1-5'),
      (14, 2, 'Hệ thống cảnh báo & quản lý thiên tai thông minh', 'DISaster', 15, 'score', 'Scale 1-5'),
      (15, 2, 'Kế hoạch hành động về khí hậu', 'ClimateAct', 15, 'score', 'Scale/qualitative'),
      (16, 3, 'Tỷ lệ bao phủ mạng lưới giao thông phi cơ giới', 'NMT', 15, 'percent', 'NMT = L_NMT / L_R *100'),
      (17, 3, 'Tỷ lệ phương tiện công cộng ứng dụng công nghệ sạch', 'CleanPT', 15, 'percent', 'Share of clean tech vehicles in fleet'),
      (18, 3, 'Mức độ dễ tiếp cận phương tiện công cộng', 'PTaccess', 10, 'vehicles per 1000 or score', 'PT per 1000'),
      (19, 3, 'Tỷ lệ hệ thống đèn tín hiệu giao thông thông minh', 'STL', 10, 'percent', 'STL = STL_s / TL *100'),
      (20, 3, 'Tỷ lệ đường phố tích hợp cảnh báo & thông tin giao thông trực tuyến', 'RroadIT', 10, 'percent', 'percent of streets integrated'),
      (21, 3, 'Khả năng thông hành và mức phục vụ của đường phố', 'RoadCap', 10, 'score', 'Level of service'),
      (22, 3, 'Mật độ trạm quan trắc không khí tự động, liên tục', 'AQstation', 10, 'stations per area', 'Count density'),
      (23, 3, 'Khả năng cung cấp dữ liệu & cảnh báo AQ thời gian thực', 'AQdata', 10, 'score', 'Data availability & integration'),
      (24, 3, 'Kế hoạch hành động vì không khí sạch', 'CleanAirPlan', 15, 'score', 'Existence and quality of plan'),
      (25, 3, 'Mức độ ô nhiễm không khí (số ngày AQI vượt ngưỡng)', 'AQI', 10, 'days', 'Number of days AQI > threshold'),
      (26, 4, 'Đánh giá mức độ quản lý tài nguyên nước', 'WImanage', 15, 'score', 'Composite'),
      (27, 4, 'Chỉ số giảm thất thoát nguồn nước', 'WIloss', 10, 'percent', 'WIloss = (W_P - W_S) / W_P *100'),
      (28, 4, 'Chỉ số tái sử dụng nước thải', 'WIreuse', 15, 'percent', 'W_rr / W_s *100'),
      (29, 4, 'Quản lý rủi ro ngập lụt đô thị', 'FloodRisk', 15, 'score', 'Scale 1-5'),
      (30, 4, 'Hệ thống cấp nước sạch tiết kiệm năng lượng', 'Ewater', 10, 'score', 'Energy efficiency metric'),
      (31, 4, 'Hệ thống quản lý nước thải tiết kiệm năng lượng', 'Ewwater', 10, 'score', 'Energy efficiency metric'),
      (32, 4, 'Ứng dụng công nghệ số trong quản lý nước', 'DigWater', 10, 'score', 'Digitalization level'),
      (33, 4, 'Tỷ lệ tiếp cận nước sạch đô thị', 'SafeWater', 15, 'percent', 'Population served / population'),
      (34, 5, 'Các sáng kiến giảm thiểu chất thải', 'WasteInit', 10, 'score', 'Number/quality of initiatives'),
      (35, 5, 'Tỷ lệ chôn lấp rác thải sinh hoạt', 'Landfill', 15, 'percent', 'Landfilled / Generated *100'),
      (36, 5, 'Mức độ rác thải khô được thu hồi và tái chế', 'RRWI', 10, 'percent', 'Recycled & reused / generated *100'),
      (37, 5, 'Quản lý chất thải xây dựng', 'ConsWaste', 10, 'score', 'Management level'),
      (38, 5, 'Mức độ xử lý chất thải ướt', 'WetWaste', 10, 'percent or ton', 'WetWaste treated / generated'),
      (39, 5, 'Chỉ số chuyển đổi số trong quản lý chất thải', 'DigWaste', 10, 'score', 'Digitalization level'),
      (40, 5, 'Hiệu quả vận hành bãi chôn lấp', 'LandfillEff', 15, 'score', 'Operational efficiency'),
      (41, 5, 'Cải thiện phát thải khí nhà kính trong quản lý chất thải', 'GHGred', 15, 'tCO2e/year', 'GHG reduction measures');
    `);

    // Chèn dữ liệu vào bảng ScoringLevels
    await pool.query(`
      INSERT INTO ScoringLevels (indicator_id, indicator_code, level, description, score_value) VALUES
      (1, 'ENIRE', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (1, 'ENIRE', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (1, 'ENIRE', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (1, 'ENIRE', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (1, 'ENIRE', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (2, 'SENIRE', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (2, 'SENIRE', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (2, 'SENIRE', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (2, 'SENIRE', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (2, 'SENIRE', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (3, 'CO2red', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (3, 'CO2red', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (3, 'CO2red', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (3, 'CO2red', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (3, 'CO2red', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (4, 'EIsave', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (4, 'EIsave', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (4, 'EIsave', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (4, 'EIsave', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (4, 'EIsave', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (5, 'EILR', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (5, 'EILR', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (5, 'EILR', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (5, 'EILR', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (5, 'EILR', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (6, 'SLI', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (6, 'SLI', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (6, 'SLI', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (6, 'SLI', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (6, 'SLI', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (7, 'GBpromo', 1, 'Các quy trình về công trình xanh chỉ mới áp dụng ở các quận/huyện', 2),
      (7, 'GBpromo', 2, 'Hệ thống văn bản pháp luật về công trình xanh được ban hành từ cơ quan quản lý ở thành phố. Hệ thống văn bản pháp luật về tiết kiệm năng lượng được ban hành từ cơ quan quản lý ở thành phố. Triển khai các hệ thống ISO liên quan về công trình xanh', 4),
      (7, 'GBpromo', 3, 'Các chứng nhận về tòa nhà xanh đã được áp dụng. Cơ quan riêng biệt về quản lý công trình xanh', 6),
      (7, 'GBpromo', 4, 'Chương trình/chiến lược/quy hoạch các công trình xanh đáp ứng tiêu chuẩn ISO và cấp chứng nhận', 8),
      (7, 'GBpromo', 5, 'Cán bộ của cơ quan về quản lý công trình xanh và các bên liên quan được đào tạo thường xuyên. Các ấn phẩm về công trình xanh được xuất bản. Các hội thảo về công trình xanh được tổ chức thường xuyên', 10),
      (8, 'GBI', 1, 'Không có tòa nhà xanh nào được chứng nhận', 3),
      (8, 'GBI', 2, 'Lên đến 10% trong năm cơ sở được chứng nhận', 6),
      (8, 'GBI', 3, 'Lên đến 40% trong năm cơ sở được chứng nhận', 9),
      (8, 'GBI', 4, 'Lên đến 60% trong năm cơ sở được chứng nhận', 12),
      (8, 'GBI', 5, 'Tất cả các tòa nhà trong năm cơ sở được chứng nhận', 15),
      (9, 'RS-water', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (9, 'RS-water', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (9, 'RS-water', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (9, 'RS-water', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (9, 'RS-water', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (10, 'Rcover', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (10, 'Rcover', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (10, 'Rcover', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (10, 'Rcover', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (10, 'Rcover', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (11, 'Rland-p', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (11, 'Rland-p', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (11, 'Rland-p', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (11, 'Rland-p', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (11, 'Rland-p', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (12, 'Biodiv', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (12, 'Biodiv', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (12, 'Biodiv', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (12, 'Biodiv', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (12, 'Biodiv', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (13, 'GISapp', 1, 'Chưa ứng dụng GIS (quy hoạch thủ công, rời rạc, không có số hóa)', 2),
      (13, 'GISapp', 2, 'GIS cơ bản (bản đồ tĩnh, số hóa < 50%, chưa phân tích chuyên sâu)', 4),
      (13, 'GISapp', 3, 'Tích hợp thông tin quy hoạch (dữ liệu số hóa 50–75%, cập nhật định kỳ, quản lý công khai)', 6),
      (13, 'GISapp', 4, 'Phân tích không gian nâng cao (dữ liệu số hóa 75–90%, cập nhật hàng tháng)', 8),
      (13, 'GISapp', 5, 'GIS thời gian thực (Digital Twin), dữ liệu số hóa >90%, mô phỏng/ra quyết định tức thời', 10),
      (14, 'DISaster', 1, 'Hệ thống cảnh báo thủ công/truyền thống. Dự báo, ứng phó dựa vào kinh nghiệm, bản đồ giấy, thông tin rời rạc; không có trạm quan trắc tự động; cảnh báo sớm gần như không có.', 3),
      (14, 'DISaster', 2, 'Có một vài trạm quan trắc tự động nhưng mật độ thấp (<1 trạm/100 km²), kết nối dữ liệu rời rạc, cảnh báo phần lớn thủ công; chỉ có SMS/loa truyền thống.', 6),
      (14, 'DISaster', 3, 'Đã tích hợp GIS; dữ liệu trạm quan trắc quản lý trên bản đồ số, mật độ trạm 1–2 trạm/100 km²; chưa AI/IoT; cảnh báo tự động đạt 30–50%.', 9),
      (14, 'DISaster', 4, 'Đã áp dụng AI, IoT (cảm biến, phân tích tự động), mật độ trạm >2 trạm/100 km²; cảnh báo tự động đạt 50–80%; dữ liệu cập nhật liên tục nhưng chưa phủ rộng khắp TP.', 12),
      (14, 'DISaster', 5, 'Hệ thống cảnh báo đa thiên tai thông minh, mạng lưới cảm biến dày đặc (>5 trạm/100 km²), tích hợp GIS–IoT–AI–Big Data toàn thành phố, cảnh báo thời gian thực, tự động hóa >80%, thông tin cá thể hóa tới người dân.', 15),
      (15, 'ClimateAct', 1, 'Chưa xây dựng kế hoạch hành động về khí hậu hoặc chỉ dừng lại ở mức định hướng chung; không có mục tiêu, giải pháp, hay lộ trình cụ thể.', 3),
      (15, 'ClimateAct', 2, 'Đã xây dựng kế hoạch sơ bộ hoặc lồng ghép khí hậu vào quy hoạch tổng thể, nhưng thiếu mục tiêu định lượng, thiếu lộ trình thực hiện; mới dừng ở giải pháp chung hoặc tầm nhìn.', 6),
      (15, 'ClimateAct', 3, 'Có kế hoạch hành động về khí hậu được UBND ban hành, xác định mục tiêu rõ ràng (ví dụ: giảm phát thải 10–20% đến năm 2030), đã tích hợp vào quy hoạch phát triển đô thị; có phân công trách nhiệm, một số giải pháp đã được thực hiện.', 9),
      (15, 'ClimateAct', 4, 'Kế hoạch đã xác lập mục tiêu giảm phát thải trung hạn (Net Zero 2045–2050), xác định rõ lĩnh vực ưu tiên (năng lượng, giao thông, xây dựng…), có lộ trình thực hiện, cơ chế kiểm soát/giám sát (MRV), cập nhật thường xuyên.', 12),
      (15, 'ClimateAct', 5, 'Kế hoạch hành động khí hậu tích hợp toàn diện, mục tiêu Net Zero hoặc trung hòa carbon trước 2050, đã thực thi các dự án giảm phát thải lớn, có hệ thống giám sát MRV minh bạch, công khai kết quả hàng năm, kết nối với các mạng lưới quốc tế (C40, Race to Zero), thu hút sự tham gia cộng đồng và doanh nghiệp.', 15),
      (16, 'NMT', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (16, 'NMT', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (16, 'NMT', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (16, 'NMT', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (16, 'NMT', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (17, 'CleanPT', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 3),
      (17, 'CleanPT', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 6),
      (17, 'CleanPT', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 9),
      (17, 'CleanPT', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 12),
      (17, 'CleanPT', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 15),
      (18, 'PTaccess', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (18, 'PTaccess', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (18, 'PTaccess', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (18, 'PTaccess', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (18, 'PTaccess', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (19, 'STL', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (19, 'STL', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (19, 'STL', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (19, 'STL', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (19, 'STL', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (20, 'RroadIT', 1, 'Mô tả Mức 1 - có thể chỉnh sửa', 2),
      (20, 'RroadIT', 2, 'Mô tả Mức 2 - có thể chỉnh sửa', 4),
      (20, 'RroadIT', 3, 'Mô tả Mức 3 - có thể chỉnh sửa', 6),
      (20, 'RroadIT', 4, 'Mô tả Mức 4 - có thể chỉnh sửa', 8),
      (20, 'RroadIT', 5, 'Mô tả Mức 5 - có thể chỉnh sửa', 10),
      (21, 'RoadCap', 1, 'Tỷ lệ mạng lưới giao thông thông thoáng (mức A – B): 0 - < 35%', 2),
      (21, 'RoadCap', 2, 'Tỷ lệ mạng lưới giao thông thông thoáng (mức A – B): 35% - < 50%', 4),
      (21, 'RoadCap', 3, 'Tỷ lệ mạng lưới giao thông thông thoáng (mức A – B): 50% - < 75%', 6),
      (21, 'RoadCap', 4, 'Tỷ lệ mạng lưới giao thông thông thoáng (mức A – B): 75% - < 90%', 8),
      (21, 'RoadCap', 5, 'Tỷ lệ mạng lưới giao thông thông thoáng (mức A – B): 90% - 100%', 10),
      (22, 'AQstation', 1, 'Không có trạm quan trắc không khí tự động, liên tục', 2),
      (22, 'AQstation', 2, 'Có trạm quan trắc không khí tự động, liên tục ≤ 12 trạm', 4),
      (22, 'AQstation', 3, 'Có trạm quan trắc không khí tự động, liên tục từ > 12 – 15 trạm', 6),
      (22, 'AQstation', 4, 'Có trạm quan trắc không khí tự động, liên tục từ > 15 – 20 trạm', 8),
      (22, 'AQstation', 5, 'Có trạm quan trắc không khí tự động, liên tục > 20 trạm', 10),
      (23, 'AQdata', 1, 'Chưa công bố', 2),
      (23, 'AQdata', 2, 'Có công bố chỉ số bụi mịn (PM10/ PM2.5) công khai trên cổng thông tin của cơ quan quản lý.', 4),
      (23, 'AQdata', 3, 'Có công bố công khai với đa thông số theo quy định tại Thông tư 10/2021/TT-BTNMT trên cổng thông tin của cơ quan quản lý.', 6),
      (23, 'AQdata', 4, 'Có công bố công khai với đa thông số theo quy định tại Thông tư 10/2021/TT-BTNMT và tích hợp trên những nền tảng khác ngoài cổng thông tin của cơ quan quản lý.', 8),
      (23, 'AQdata', 5, 'Có công bố công khai với đa thông số theo quy định tại Thông tư 10/2021/TT-BTNMT, có tích hợp trên những nền tảng khác ngoài cổng thông tin của cơ quan quản lý và tích hợp chức năng khuyến nghị, cảnh báo đối với cộng đồng, đặc biệt là các nhóm đối tượng nhạy cảm.', 10),
      (24, 'CleanAirPlan', 1, 'Không cân nhắc', 3),
      (24, 'CleanAirPlan', 2, 'Giám sát và công bố dữ liệu: Thực hiện quan trắc các thông số bắt buộc theo quy định. Công bố dữ liệu quan trắc với cộng đồng', 6),
      (24, 'CleanAirPlan', 3, 'Tuân thủ mục tiêu kế hoạch hành động của quốc gia về không khí. Có kế hoạch thực hiện kiểm soát, cải thiện chất lượng môi trường không khí.', 9),
      (24, 'CleanAirPlan', 4, 'Chất lượng môi trường không khí được cải thiện. Đạt được mục tiêu của kế hoạch kiểm soát, cải thiện chất lượng môi trường không khí đã đề ra (tính trong một năm gần nhất).', 12),
      (24, 'CleanAirPlan', 5, 'Tất cả chỉ số giám sát theo quy định Đạt QCVN về chất lượng không khí (tính trong một năm gần nhất).', 15),
      (25, 'AQI', 1, '0%', 2),
      (25, 'AQI', 2, '0% - < 70%', 4),
      (25, 'AQI', 3, '70 – < 75%', 6),
      (25, 'AQI', 4, '75 – < 80%', 8),
      (25, 'AQI', 5, '≥ 80%', 10),
      (26, 'WImanage', 1, 'Đánh giá sơ bộ nguồn nước', 3),
      (26, 'WImanage', 2, 'Báo cáo kiểm kê nguồn nước hiện có, dự báo nhu cầu nước trong tương lai và khả năng cung cấp nước giai đoạn 5 năm', 6),
      (26, 'WImanage', 3, 'Kế hoạch Quản lý Tài nguyên nước được xây dựng với các Hành động Ngắn hạn, Trung hạn và Dài hạn', 9),
      (26, 'WImanage', 4, 'Báo cáo cân bằng nước nhằm đáp ứng nhu cầu nước trong tương lai', 12),
      (26, 'WImanage', 5, 'Lồng ghép kịch bản biến đổi khí hậu đến kế hoạch quản lý nguồn nước trong tương lai', 15),
      (27, 'WIloss', 1, '25%', 2),
      (27, 'WIloss', 2, '18%', 4),
      (27, 'WIloss', 3, '>15%', 6),
      (27, 'WIloss', 4, '15% - 12%', 8),
      (27, 'WIloss', 5, '<12%', 10),
      (28, 'WIreuse', 1, '0', 3),
      (28, 'WIreuse', 2, '<5%', 6),
      (28, 'WIreuse', 3, '5% - 15%', 9),
      (28, 'WIreuse', 4, '15% - 30%', 12),
      (28, 'WIreuse', 5, 'Trên 30%', 15),
      (29, 'FloodRisk', 1, 'Chưa có hệ thống cảnh báo sớm. Giám sát thủ công bằng con người. Không có cảm biến mực nước hoặc dữ liệu thời gian thực.', 3),
      (29, 'FloodRisk', 2, 'Triển khai cảm biến mực nước ở một số điểm đen. Có bản đồ điểm ngập nhưng chưa tích hợp GIS/IoT. Cảnh báo ngập lụt gửi qua hệ thống nội bộ hoặc báo thủ công. Có kế hoạch ứng phó ngập nhưng không cập nhật thường xuyên', 6),
      (29, 'FloodRisk', 3, 'Hệ thống cảm biến mực nước hoạt động thời gian thực tại các điểm quan trọng. Ứng dụng phần mềm GIS mô phỏng thoát nước mưa (ví dụ: SWMM, MIKE URBAN). Hệ thống cảnh báo kết nối đến người dân (SMS, app). Có cơ chế điều tiết cống, hồ chứa bán tự động.', 9),
      (29, 'FloodRisk', 4, 'Hệ thống cảm biến toàn diện (mưa, dòng chảy, ngập cục bộ, áp lực cống). Tích hợp AI phân tích và cảnh báo sớm dựa trên dự báo thời tiết. Hệ thống phản ứng tự động: đóng/mở van, điều khiển máy bơm. Kết nối hệ thống giao thông để cảnh báo và điều hướng dòng xe.', 12),
      (29, 'FloodRisk', 5, 'Quản lý ngập tích hợp vào chiến lược đô thị chống chịu khí hậu (theo SDG 11, 13). Tích hợp dữ liệu ngập với năng lượng, nước, chất thải, y tế, dân cư. Sử dụng dữ liệu vệ tinh, mô hình học máy để dự đoán và lập kế hoạch đô thị. Dữ liệu mở, người dân và doanh nghiệp được truy cập và phản hồi thông tin thời gian thực.', 15),
      (30, 'Ewater', 1, 'Báo cáo kiểm toán công suất bơm tại các trạm', 2),
      (30, 'Ewater', 2, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 5% - 10%', 4),
      (30, 'Ewater', 3, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 10% - 15%', 6),
      (30, 'Ewater', 4, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 15% - 20%', 8),
      (30, 'Ewater', 5, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 20% - 25%', 10),
      (31, 'Ewwater', 1, 'Báo cáo kiểm toán công suất bơm tại các trạm', 2),
      (31, 'Ewwater', 2, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 5% - 10%', 4),
      (31, 'Ewwater', 3, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 10% - 15%', 6),
      (31, 'Ewwater', 4, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 15% - 20%', 8),
      (31, 'Ewwater', 5, 'Tính toán với kết quả giảm năng lượng so với giai đoạn 5 năm trước là 20% - 25%', 10),
      (32, 'DigWater', 1, 'Có dữ liệu vận hành giấy/tệp', 2),
      (32, 'DigWater', 2, '>10% giám sát từ xa bằng SCADA. Có tích hợp GIS để theo dõi mạng lưới cấp nước', 4),
      (32, 'DigWater', 3, '10% - 50% giám sát từ xa bằng SCADA. Có Dashboard nội bộ. Tích hợp GIS để theo dõi mạng lưới cấp nước', 6),
      (32, 'DigWater', 4, '50% - 70% giám sát từ xa bằng SCADA. Có Dashboard nội bộ. Tích hợp GIS để theo dõi mạng lưới cấp nước', 8),
      (32, 'DigWater', 5, 'Trên 70% giám sát từ xa bằng SCADA. Có Dashboard công khai. Tích hợp GIS để theo dõi mạng lưới cấp nước. Tích hợp GIS toàn diện trong quản lý và giám sát', 10),
      (33, 'SafeWater', 1, '>50% dân số đô thị tiếp cận nước sạch', 3),
      (33, 'SafeWater', 2, '50 – <75% dân số đô thị tiếp cận nước sạch', 6),
      (33, 'SafeWater', 3, '75 – <90% dân số đô thị tiếp cận nước sạch', 9),
      (33, 'SafeWater', 4, '90 – <100% dân số đô thị tiếp cận nước sạch', 12),
      (33, 'SafeWater', 5, '100% dân số đô thị tiếp cận nước sạch', 15),
      (34, 'WasteInit', 1, 'Không có sáng kiến', 2),
      (34, 'WasteInit', 2, 'Có đăng ký các sáng kiến', 4),
      (34, 'WasteInit', 3, 'Có áp dụng các sáng kiến', 6),
      (34, 'WasteInit', 4, 'Có áp dụng các sáng kiến và đánh giá hiệu quả', 8),
      (34, 'WasteInit', 5, 'Có áp dụng các sáng kiến và nhân rộng sáng kiến', 10),
      (35, 'Landfill', 1, 'WI > 70%', 3),
      (35, 'Landfill', 2, 'WI: ≤ 70% - ≤ 50%', 6),
      (35, 'Landfill', 3, 'WI: > 50% - ≤ 30%', 9),
      (35, 'Landfill', 4, 'WI: > 30% - 10%', 12),
      (35, 'Landfill', 5, 'WI: ≤ 10%', 15),
      (36, 'RRWI', 1, 'Thành phố có ưu tiên cho việc tái sử dụng CTR', 2),
      (36, 'RRWI', 2, 'Có thu hồi vật liệu và có tồn tại cơ sở phân đoạn tái chế', 4),
      (36, 'RRWI', 3, '10%', 6),
      (36, 'RRWI', 4, '10% - 20%', 8),
      (36, 'RRWI', 5, '> 20%', 10),
      (37, 'ConsWaste', 1, 'Có tồn tại các hệ thống xử lý CTXD', 2),
      (37, 'ConsWaste', 2, 'Có điểm thu gom chất thải XD hiện hữu', 4),
      (37, 'ConsWaste', 3, 'Có vận chuyển và xử lý chuyên dụng cho chất thải XD hiện hữu. CS3.1 > 70%', 6),
      (37, 'ConsWaste', 4, 'Có xử lý chuyên dụng cho chất thải XD. CS3.2 > 50%', 8),
      (37, 'ConsWaste', 5, 'Tái sử dụng và tái chế chất thải XD. CS3.2 = 100%', 10),
      (38, 'WetWaste', 1, '< 10%', 2),
      (38, 'WetWaste', 2, '10% – < 30%', 4),
      (38, 'WetWaste', 3, '30% – < 50%', 6),
      (38, 'WetWaste', 4, '50% – < 75%', 8),
      (38, 'WetWaste', 5, '≥ 75%', 10),
      (39, 'DigWaste', 1, 'Không áp dụng công nghệ số trong quản lý chất thải', 2),
      (39, 'DigWaste', 2, 'Có hệ thống quản lý dữ liệu nội bộ (Excel, email…)', 4),
      (39, 'DigWaste', 3, 'Thùng rác công cộng có cảm biến, ứng dụng GPS để giám sát xe thu gom', 6),
      (39, 'DigWaste', 4, 'Có hệ thống quản lý tập trung, liên thông các cơ quan, sử dụng cảm biến, thu thập dữ liệu thời gian thực', 8),
      (39, 'DigWaste', 5, 'Hệ thống tích hợp: ICT + GIS + AI + cổng cung cấp thông tin công khai', 10),
      (40, 'LandfillEff', 1, 'Còn tồn tại các bãi chôn lấp không hợp vệ sinh và chưa có phương án xử lý.', 3),
      (40, 'LandfillEff', 2, 'Có phương án xử lý ô nhiễm, cải tạo đáp ứng yêu cầu về bảo vệ môi trường đối với các bãi chôn lấp không hợp vệ sinh. Xử lý triệt để các bãi chôn lấp chất thải sinh hoạt tự phát và ngăn chặn kịp thời việc hình thành các bãi chôn lấp tự phát.', 6),
      (40, 'LandfillEff', 3, '90 - 95% các bãi chôn lấp chất thải rắn sinh hoạt tại các đô thị đã đóng cửa được cải tạo, xử lý, tái sử dụng đất.', 9),
      (40, 'LandfillEff', 4, 'Tất cả các bãi chôn lấp được xây dựng và vận hành theo đúng quy định quản lý chất thải rắn.', 12),
      (40, 'LandfillEff', 5, 'Không đầu tư mới bãi chôn lấp để xử lý chất thải rắn công nghiệp thông thường (trừ trường hợp phù hợp với nội dung quản lý chất thải rắn trong các quy hoạch có liên quan).', 15),
      (41, 'GHGred', 1, '0', 3),
      (41, 'GHGred', 2, '< 25%', 6),
      (41, 'GHGred', 3, '25% - <50%', 9),
      (41, 'GHGred', 4, '50% - >75%', 12),
      (41, 'GHGred', 5, '≥75%', 15);
    `);

    // Chèn dữ liệu vào bảng DomainWeights
    await pool.query(`
      INSERT INTO DomainWeights (item_type, domain_id, item_code, weight) VALUES
      ('domain', 1, 'Năng lượng & Công trình xanh', 0.2),
      ('domain', 2, 'Quy hoạch đô thị, phủ xanh & đa dạng sinh học', 0.18),
      ('domain', 3, 'Giao thông đô thị & chất lượng không khí', 0.24),
      ('domain', 4, 'Quản lý nước', 0.19),
      ('domain', 5, 'Quản lý chất thải', 0.19);
    `);

    // Chèn dữ liệu vào bảng IndicatorWeights
    await pool.query(`
      INSERT INTO IndicatorWeights (indicator_id, indicator_code, domain_id, weight_within_domain) VALUES
      (1, 'ENIRE', 1, 0.125),
      (2, 'SENIRE', 1, 0.125),
      (3, 'CO2red', 1, 0.125),
      (4, 'EIsave', 1, 0.125),
      (5, 'EILR', 1, 0.125),
      (6, 'SLI', 1, 0.125),
      (7, 'GBpromo', 1, 0.125),
      (8, 'GBI', 1, 0.125),
      (9, 'RS-water', 2, 0.1429),
      (10, 'Rcover', 2, 0.1429),
      (11, 'Rland-p', 2, 0.1429),
      (12, 'Biodiv', 2, 0.1429),
      (13, 'GISapp', 2, 0.1429),
      (14, 'DISaster', 2, 0.1429),
      (15, 'ClimateAct', 2, 0.1429),
      (16, 'NMT', 3, 0.1),
      (17, 'CleanPT', 3, 0.1),
      (18, 'PTaccess', 3, 0.1),
      (19, 'STL', 3, 0.1),
      (20, 'RroadIT', 3, 0.1),
      (21, 'RoadCap', 3, 0.1),
      (22, 'AQstation', 3, 0.1),
      (23, 'AQdata', 3, 0.1),
      (24, 'CleanAirPlan', 3, 0.1),
      (25, 'AQI', 3, 0.1),
      (26, 'WImanage', 4, 0.125),
      (27, 'WIloss', 4, 0.125),
      (28, 'WIreuse', 4, 0.125),
      (29, 'FloodRisk', 4, 0.125),
      (30, 'Ewater', 4, 0.125),
      (31, 'Ewwater', 4, 0.125),
      (32, 'DigWater', 4, 0.125),
      (33, 'SafeWater', 4, 0.125),
      (34, 'WasteInit', 5, 0.125),
      (35, 'Landfill', 5, 0.125),
      (36, 'RRWI', 5, 0.125),
      (37, 'ConsWaste', 5, 0.125),
      (38, 'WetWaste', 5, 0.125),
      (39, 'DigWaste', 5, 0.125),
      (40, 'LandfillEff', 5, 0.125),
      (41, 'GHGred', 5, 0.125);
    `);

    // Chèn dữ liệu mẫu vào Assessments_Template
    await pool.query(`
      INSERT INTO Assessments_Template (city, year, domain_id, indicator_id, indicator_code, value, unit_code, score_awarded, assessor, date, level, description)
      VALUES
      ('TP. Hồ Chí Minh', 2025, 1, 1, 'ENIRE', '10', 'percent', 3, 'admin', CURRENT_DATE, 1, 'Mô tả Mức 1 - có thể chỉnh sửa'),
      ('TP. Hồ Chí Minh', 2025, 1, 6, 'SLI', '12', 'percent or count', 4, 'admin', CURRENT_DATE, 2, 'Mô tả Mức 2 - có thể chỉnh sửa'),
      ('TP. Hồ Chí Minh', 2025, 1, 7, 'GBpromo', '21', 'score', 6, 'admin', CURRENT_DATE, 3, 'Có cơ quan quản lý công trình xanh');
    `);

    // Chèn dữ liệu mẫu vào users
    await pool.query(`
      INSERT INTO users (username, password, role) VALUES
      ('admin', '${bcrypt.hashSync('admin', 10)}', 'admin'),
      ('user', '${bcrypt.hashSync('password', 10)}', 'user');
    `);

    dbInitialized = true;
    console.log('✅ Khởi tạo cơ sở dữ liệu thành công.');
  } catch (err) {
    console.error('❌ Lỗi khởi tạo cơ sở dữ liệu:', err);
    throw err;
  }
}

// Middleware xác thực token
function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.redirect('/?error=Vui lòng đăng nhập');
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET);
    req.user = user;
    next();
  } catch (err) {
    console.error('Lỗi xác thực token:', err);
    res.clearCookie('token');
    res.redirect('/?error=Token không hợp lệ');
  }
}

// Middleware kiểm tra vai trò
function checkRole(role) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) {
      next();
    } else {
      res.redirect('/?error=Không có quyền truy cập');
    }
  };
}

// Lấy GeoJSON
async function getGeoJSON(city = 'TP. Hồ Chí Minh') {
  try {
    const result = await pool.query(`
      SELECT $1 AS city, 
             ST_AsGeoJSON(ST_SetSRID(ST_MakePoint(106.7009, 10.7769), 4326)) AS geojson
    `, [city]);
    return {
      type: 'FeatureCollection',
      features: result.rows.map((row) => ({
        type: 'Feature',
        geometry: JSON.parse(row.geojson),
        properties: { city: row.city },
      })),
    };
  } catch (err) {
    console.error('Lỗi lấy GeoJSON:', err);
    return null;
  }
}

async function getCachedOrQuery(key, query) {
  try {
    const cached = await redis.get(key);
    if (cached) {
      console.log(`✅ Lấy ${key} từ Redis cache`);
      return JSON.parse(cached);
    }
    const result = await pool.query(query);
    const data = result.rows;
    await redis.set(key, JSON.stringify(data), 'EX', 3600); 
    console.log(`✅ Lưu ${key} vào Redis cache`);
    return data;
  } catch (err) {
    console.warn(`⚠️ Lỗi Redis khi lấy ${key}, dùng PostgreSQL:`, err.message);
    const result = await pool.query(query);
    return result.rows;
  }
}

// Tuyến đường GET /
app.get('/', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'index.ejs');
    await fs.access(viewPath); // Kiểm tra sự tồn tại của index.ejs
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private'); // Ngăn cache
    
    // Lấy năm từ query hoặc mặc định là năm hiện tại
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';
    const cacheKey = `data:${city}:${year}`;
    
    // Truy vấn dữ liệu tổng hợp
    const data = await getCachedOrQuery(cacheKey, `
      SELECT 
        city AS district,
        ROUND(AVG(score_awarded) / 1000 * 100, 1) || '%' AS khi_hau,
        ROUND(AVG(score_awarded), 0) || '/1000' AS diem,
        CASE 
          WHEN AVG(score_awarded) >= 800 THEN 'Level 5'
          WHEN AVG(score_awarded) >= 600 THEN 'Level 4'
          WHEN AVG(score_awarded) >= 400 THEN 'Level 3'
          WHEN AVG(score_awarded) >= 200 THEN 'Level 2'
          ELSE 'Level 1'
        END AS level
      FROM Assessments_Template
      WHERE city = '${city}' AND year = ${year}
      GROUP BY city
    `);
    
    // Dữ liệu mẫu nếu không có dữ liệu từ DB
    const sampleData = data.length > 0 ? data : [
      { district: 'TP. Hồ Chí Minh', khi_hau: '87.5%', diem: '875/1000', level: 'Level 5' }
    ];
    
    res.render('index', {
      data: sampleData,
      error: req.query.error || null,
      success: req.query.success || null,
      selectedYear: year,
      years: [2023, 2024, 2025] // Danh sách năm cho dropdown
    });
  } catch (err) {
    console.error('❌ Lỗi trong route gốc:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang chính hoặc lỗi khi tải dữ liệu',
      success: null,
    });
  }
});

// Tuyến đường GET /login
app.get('/login', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'login.ejs');
    await fs.access(viewPath);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.render('login', {
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('❌ Tệp login.ejs không tồn tại:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang đăng nhập',
      success: null,
    });
  }
});

// Tuyến đường GET /register
app.get('/register', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'register.ejs');
    await fs.access(viewPath);
    res.render('register', {
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('❌ Tệp register.ejs không tồn tại:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang đăng ký',
      success: null,
    });
  }
});

// Tuyến đường GET /index
app.get('/index', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'index.ejs');
    await fs.access(viewPath);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    // Lấy năm từ query hoặc mặc định là năm hiện tại
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';
    const cacheKey = `data:${city}:${year}`;
    
    // Truy vấn dữ liệu tổng hợp
    const data = await getCachedOrQuery(cacheKey, `
      SELECT 
        city AS district,
        ROUND(AVG(score_awarded) / 1000 * 100, 1) || '%' AS khi_hau,
        ROUND(AVG(score_awarded), 0) || '/1000' AS diem,
        CASE 
          WHEN AVG(score_awarded) >= 800 THEN 'Level 5'
          WHEN AVG(score_awarded) >= 600 THEN 'Level 4'
          WHEN AVG(score_awarded) >= 400 THEN 'Level 3'
          WHEN AVG(score_awarded) >= 200 THEN 'Level 2'
          ELSE 'Level 1'
        END AS level
      FROM Assessments_Template
      WHERE city = '${city}' AND year = ${year}
      GROUP BY city
    `);
    
    // Dữ liệu mẫu nếu không có dữ liệu từ DB
    const sampleData = data.length > 0 ? data : [
      { district: 'TP. Hồ Chí Minh', khi_hau: '87.5%', diem: '875/1000', level: 'Level 5' }
    ];
    
    res.render('index', {
      data: sampleData,
      error: req.query.error || null,
      success: req.query.success || null,
      selectedYear: year,
      years: [2023, 2024, 2025]
    });
  } catch (err) {
    console.error('❌ Tệp index.ejs không tồn tại:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang chính hoặc lỗi khi tải dữ liệu',
      success: null,
    });
  }
});

// Tuyến đường GET /edit_cndl
app.get('/edit_cndl', authenticateToken, (req, res) => {
  res.redirect('/qldl');
});

app.post('/register', [
  body('username').trim().notEmpty().withMessage('Tên người dùng không được để trống'),
  body('password').notEmpty().withMessage('Mật khẩu không được để trống'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.redirect(`/register?error=${encodeURIComponent(errors.array()[0].msg)}`);
  }

  const { username, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length > 0) {
      return res.redirect('/register?error=Tên người dùng đã tồn tại');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hashedPassword, 'user']);
    res.redirect('/?success=Đăng ký thành công, vui lòng đăng nhập');
  } catch (err) {
    console.error('Lỗi POST /register:', err);
    res.redirect('/register?error=Lỗi khi đăng ký');
  }
});

app.get('/index', authenticateToken, (req, res) => {
  res.redirect('/dashboard');
});

app.get('/edit_cndl', authenticateToken, (req, res) => {
  res.redirect('/qldl');
});

app.post(
  '/login',
  [
    body('username').trim().notEmpty().withMessage('Tên người dùng không được để trống'),
    body('password').notEmpty().withMessage('Mật khẩu không được để trống'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.redirect(`/?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    const { username, password } = req.body;
    try {
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        return res.redirect('/?error=Không tìm thấy người dùng');
      }

      const user = result.rows[0];
      if (!bcrypt.compareSync(password, user.password)) {
        return res.redirect('/?error=Mật khẩu không đúng');
      }

      const token = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET, {
        expiresIn: '24h', // Tăng thời gian sống token từ 1h lên 24h
      });
      res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Lỗi POST /login:', err);
      res.redirect('/?error=Đăng nhập thất bại');
    }
  }
);

app.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    const domains = await getCachedOrQuery('domains', 'SELECT * FROM Domains ORDER BY domain_id');
    const indicators = await getCachedOrQuery('indicators', 'SELECT * FROM Indicators ORDER BY domain_id, indicator_id');

    const assessmentsRes = await pool.query(
      `
      SELECT a.*, d.name AS domain_name, i.name AS indicator_name
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.domain_id, a.indicator_id
      `,
      [city, year]
    );
    const assessments = assessmentsRes.rows;

    const domainScores = {};
    domains.forEach((domain) => {
      const domainAssessments = assessments.filter((a) => a.domain_id === domain.domain_id);
      domainScores[domain.domain_id] = domainAssessments.reduce((sum, a) => sum + (a.score_awarded || 0), 0);
    });

    const totalScore = Object.values(domainScores).reduce((sum, score) => sum + score, 0);
    const totalMaxScore = domains.reduce((sum, d) => sum + (d.max_score || 0), 0);
    const overallLevel = Math.min(5, Math.ceil((totalScore / totalMaxScore) * 5));

    const geojson = await getGeoJSON(city);

    // Lấy danh sách năm
    const yearsRes = await pool.query(
      'SELECT DISTINCT year FROM Assessments_Template WHERE city = $1 ORDER BY year DESC',
      [city]
    );
    const years = yearsRes.rows.map(row => row.year);

    res.render('dashboard', {
      user,
      domains,
      indicators,
      assessments,
      domainScores,
      totalScore,
      overallLevel,
      geojson,
      years,
      selectedYear: year,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('Lỗi GET /dashboard:', err.message, err.stack);
    res.render('dashboard', {
      user: req.user,
      domains: [],
      indicators: [],
      assessments: [],
      domainScores: {},
      totalScore: 0,
      overallLevel: 1,
      geojson: null,
      years: [],
      selectedYear: null,
      error: 'Lỗi khi lấy dữ liệu dashboard',
      success: null,
    });
  }
});

app.get('/cndl', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    // Lấy dữ liệu Domains từ Redis hoặc database
    let domains = { rows: [] };
    const cachedDomains = await redis.get('domains');
    if (cachedDomains) {
      try {
        const parsedDomains = JSON.parse(cachedDomains);
        domains = { rows: Array.isArray(parsedDomains) ? parsedDomains : [] };
      } catch (parseErr) {
        console.warn('⚠️ Dữ liệu Redis domains không hợp lệ, sử dụng database:', parseErr.message);
      }
    }
    if (!cachedDomains || domains.rows.length === 0) {
      const result = await pool.query('SELECT * FROM Domains');
      domains = result;
      if (result.rows && result.rows.length > 0) {
        await redis.set('domains', JSON.stringify(result.rows), 'EX', 3600);
      }
    }

    // Lấy dữ liệu Indicators từ Redis hoặc database
    let indicators = { rows: [] };
    const cachedIndicators = await redis.get('indicators');
    if (cachedIndicators) {
      try {
        const parsedIndicators = JSON.parse(cachedIndicators);
        indicators = { rows: Array.isArray(parsedIndicators) ? parsedIndicators : [] };
      } catch (parseErr) {
        console.warn('⚠️ Dữ liệu Redis indicators không hợp lệ, sử dụng database:', parseErr.message);
      }
    }
    if (!cachedIndicators || indicators.rows.length === 0) {
      const result = await pool.query('SELECT * FROM Indicators');
      indicators = result;
      if (result.rows && result.rows.length > 0) {
        await redis.set('indicators', JSON.stringify(result.rows), 'EX', 3600);
      }
    }

    // Kiểm tra và xử lý domains.rows
    const domainsWithIcons = Array.isArray(domains.rows) ? domains.rows.map(domain => ({
      ...domain,
      icon: domain.icon || getDefaultIcon(domain.domain_id)
    })) : [];

    function getDefaultIcon(domainId) {
      const iconMap = {
        1: 'fas fa-bolt',
        2: 'fas fa-leaf',
        3: 'fas fa-car',
        4: 'fas fa-tint',
        5: 'fas fa-trash'
      };
      return iconMap[domainId] || 'fas fa-cog';
    }

    res.render('cndl', {
      user,
      city,
      domains: domainsWithIcons,
      indicators: indicators.rows || [],
      year,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('Lỗi GET /cndl:', err);
    res.render('cndl', {
      user: req.user,
      city: 'TP. Hồ Chí Minh',
      domains: [],
      indicators: [],
      year: new Date().getFullYear(),
      error: 'Lỗi khi tải dữ liệu: ' + err.message,
      success: null,
    });
  }
});
app.post(
  '/cndl',
  authenticateToken,
  [
    body('year').isInt({ min: 2000, max: 2100 }).withMessage('Năm phải là số từ 2000 đến 2100'),
    body('indicators.*.value')
      .optional({ checkFalsy: true })
      .trim()
      .customSanitizer((value) => value.replace(',', '.').replace(/[^\d.]/g, ''))
      .matches(/^\d+(\.\d*)?$/ )
      .withMessage('Giá trị chỉ số phải là số dương, ví dụ: 45 hoặc 45.5 (sử dụng dấu chấm cho phần thập phân)'),
    body('indicators.*.level')
      .optional({ checkFalsy: true })
      .isInt({ min: 1, max: 5 })
      .withMessage('Mức phải từ 1 đến 5'),
    body('indicators.*.params').optional().isObject().withMessage('Tham số bổ sung phải là object'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Lỗi validation:', errors.array());
      return res.redirect(`/cndl?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    const { year, indicators: indData } = req.body;
    const city = 'TP. Hồ Chí Minh';
    const assessor = req.user.username;

    try {
      const indicatorsRes = await pool.query('SELECT * FROM Indicators');
      const indicators = indicatorsRes.rows;
      const scoringLevelsRes = await pool.query('SELECT * FROM ScoringLevels');
      const scoringLevels = scoringLevelsRes.rows;

      console.log('Dữ liệu form:', JSON.stringify(indData, null, 2));

      const insertValues = [];
      const historyValues = [];
      for (const [code, data] of Object.entries(indData)) {
        if (!data.value && !data.level) continue;
        const indicator = indicators.find((i) => i.code === code);
        if (!indicator) {
          console.warn(`Không tìm thấy chỉ số ${code}`);
          continue;
        }

        let value = data.value ? parseFloat(data.value) : null;
        let level = data.level ? parseInt(data.level) : null;
        let additionalParams = data.params || {};

        if (value && !/^\d+(\.\d*)?$/.test(data.value)) {
          console.error(`Giá trị không hợp lệ cho ${indicator.code}: ${data.value}`);
          continue;
        }

        if (value && isNaN(value)) {
          console.error(`Không thể chuyển đổi giá trị cho ${indicator.code}: ${data.value}`);
          continue;
        }

        if (value && indicator.unit_code === 'percent' && (value < 0 || value > 100)) {
          return res.redirect(`/cndl?error=${encodeURIComponent(`Giá trị cho ${indicator.code} phải từ 0-100%`)}`);
        }

        let calculatedScore = 0;
        let levelData = { level: 1, score_value: 0, description: 'Không có mô tả' };

        // Tính toán score và ánh xạ level cho tất cả chỉ số
        if (value) {
          if (indicator.formula && indicator.formula !== 'Qualitative/score by policy' && !['Scale 1-5', 'Data availability & integration', 'Existence and quality of plan', 'Composite', 'Count density', 'Number of days AQI > threshold', 'Digitalization level', 'Number/quality of initiatives', 'Operational efficiency', 'GHG reduction measures', 'Level of service'].includes(indicator.formula)) {
            calculatedScore = evaluateFormula(indicator.formula, value, additionalParams);
          } else {
            calculatedScore = value;
          }

          levelData = scoringLevels
            .filter((sl) => sl.indicator_id === indicator.indicator_id)
            .reduce((prev, current) => {
              return Math.abs(current.score_value - calculatedScore) < Math.abs(prev.score_value - calculatedScore) ? current : prev;
            }, scoringLevels.find((sl) => sl.indicator_id === indicator.indicator_id) || { level: 1, score_value: 0, description: 'Không có mô tả' });
        } else if (level) {
          levelData = scoringLevels.find((sl) => sl.indicator_id === indicator.indicator_id && sl.level === level);
          if (!levelData) {
            return res.redirect(`/cndl?error=${encodeURIComponent(`Không tìm thấy mức ${level} cho chỉ số ${indicator.code}`)}`);
          }
          calculatedScore = levelData.score_value;
        }

        // Lấy dữ liệu cũ để ghi log
        const oldQuery = await pool.query(
          `
          SELECT value, score_awarded, level, description
          FROM Assessments_Template
          WHERE city = $1 AND year = $2 AND indicator_code = $3
          `,
          [city, year, indicator.code]
        );
        const oldValues = oldQuery.rows[0] ? oldQuery.rows[0] : null;

        const insertRow = [
          city,
          year,
          indicator.domain_id,
          indicator.indicator_id,
          indicator.code,
          data.value || null,
          indicator.unit_code,
          levelData.score_value || Math.round(calculatedScore),
          assessor,
          new Date(),
          levelData.level,
          levelData.description
        ];

        console.log(`Insert row for ${indicator.code}:`, insertRow);
        if (insertRow.some(val => val === undefined)) {
          console.error(`Giá trị undefined trong insertRow cho ${indicator.code}:`, insertRow);
          return res.redirect(`/cndl?error=${encodeURIComponent(`Dữ liệu không hợp lệ cho chỉ số ${indicator.code}`)}`);
        }

        insertValues.push(insertRow);

        historyValues.push([
          'Assessments_Template',
          `${city}_${year}_${indicator.code}`,
          oldValues ? JSON.stringify(oldValues) : null,
          JSON.stringify({
            value: data.value,
            level: levelData.level,
            score: levelData.score_value || Math.round(calculatedScore),
            description: levelData.description
          }),
          assessor,
          oldValues ? 'update' : 'insert',
          req.ip,
          req.get('User-Agent'),
        ]);
      }

      if (insertValues.length > 0) {
        // Thay DELETE + INSERT bằng INSERT ... ON CONFLICT
        await pool.query(
          `
          INSERT INTO Assessments_Template (city, year, domain_id, indicator_id, indicator_code, value, unit_code, score_awarded, assessor, date, level, description)
          VALUES ${insertValues.map((_, i) => `($${i * 12 + 1}, $${i * 12 + 2}, $${i * 12 + 3}, $${i * 12 + 4}, $${i * 12 + 5}, $${i * 12 + 6}, $${i * 12 + 7}, $${i * 12 + 8}, $${i * 12 + 9}, $${i * 12 + 10}, $${i * 12 + 11}, $${i * 12 + 12})`).join(',')}
          ON CONFLICT (city, year, indicator_code)
          DO UPDATE SET
            value = EXCLUDED.value,
            unit_code = EXCLUDED.unit_code,
            score_awarded = EXCLUDED.score_awarded,
            assessor = EXCLUDED.assessor,
            date = EXCLUDED.date,
            level = EXCLUDED.level,
            description = EXCLUDED.description
          `,
          insertValues.flat()
        );

        // Ghi log vào edit_history
        if (historyValues.length > 0) {
          await pool.query(
            `
            INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
            VALUES ${historyValues.map((_, i) => `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`).join(',')}
            `,
            historyValues.flat()
          );
        }
      }

      await redis.del('assessments_template');
      res.redirect(`/dashboard?year=${year}&success=${encodeURIComponent('Dữ liệu đã được được lưu thành công')}`);
    } catch (err) {
      console.error('Lỗi POST /cndl:', err.message, err.stack);
      res.redirect(`/cndl?error=${encodeURIComponent('Lỗi khi lưu dữ liệu: ' + err.message)}`);
    }
  }
);

// Endpoint GET /edit_cndl/:id
app.get('/edit_cndl/:id', authenticateToken, async (req, res) => {
  console.log(`✅ Truy cập /edit_cndl/${req.params.id}`);
  try {
    const result = await pool.query(
      `
      SELECT a.*, d.name AS domain_name, i.name AS indicator_name, i.code AS indicator_code
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.assessment_id = $1
      `,
      [req.params.id]
    );
    const item = result.rows[0];
    if (!item) {
      console.warn(`⚠️ Không tìm thấy bản ghi với assessment_id: ${req.params.id}`);
      return res.render('edit_cndl', {
        table: 'Assessments_Template',
        item: null,
        fields: [],
        geojson: null,
        user: req.user,
        error: 'Không tìm thấy dữ liệu để sửa',
        success: null
      });
    }

    // Define fields to display in the form
    const fields = ['city', 'year', 'indicator_code', 'value', 'unit_code', 'score_awarded', 'assessor'];
    const geojson = await getGeoJSON(item.city);

    res.render('edit_cndl', {
      table: 'Assessments_Template',
      item,
      fields,
      geojson,
      user: req.user,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('❌ Lỗi GET /edit_cndl:', err.message, err.stack);
    res.render('edit_cndl', {
      table: 'Assessments_Template',
      item: null,
      fields: [],
      geojson: null,
      user: req.user,
      error: 'Lỗi khi tải dữ liệu',
      success: null
    });
  }
});

app.post(
  '/edit_cndl/:id',
  authenticateToken,
  [
    body('value')
      .trim()
      .notEmpty()
      .customSanitizer((value) => value.replace(',', '.').replace(/[^\d.]/g, ''))
      .matches(/^\d+(\.\d*)?$/)
      .withMessage('Giá trị chỉ số phải là số dương, ví dụ: 45 hoặc 45.5')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn('⚠️ Lỗi validation /edit_cndl:', errors.array());
      return res.redirect(`/edit_cndl/${req.params.id}?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    const { value } = req.body;
    const id = req.params.id;
    try {
      const oldQuery = await pool.query(
        `
        SELECT value, score_awarded
        FROM Assessments_Template
        WHERE assessment_id = $1
        `,
        [id]
      );
      if (oldQuery.rows.length === 0) {
        console.warn(`⚠️ Không tìm thấy bản ghi với assessment_id: ${id}`);
        return res.redirect(`/edit_cndl/${id}?error=${encodeURIComponent('Không tìm thấy mục')}`);
      }

      const oldValues = oldQuery.rows[0];
      const indicatorRes = await pool.query(
        `
        SELECT i.indicator_id, i.code, i.formula, i.unit_code
        FROM Assessments_Template a
        JOIN Indicators i ON a.indicator_id = i.indicator_id
        WHERE a.assessment_id = $1
        `,
        [id]
      );
      const indicator = indicatorRes.rows[0];

      let calculatedValue = parseFloat(value);
      if (isNaN(calculatedValue)) {
        return res.redirect(`/edit_cndl/${id}?error=${encodeURIComponent('Giá trị không hợp lệ')}`);
      }
      if (indicator.unit_code === 'percent' && (calculatedValue < 0 || calculatedValue > 100)) {
        return res.redirect(`/edit_cndl/${id}?error=${encodeURIComponent('Giá trị phải từ 0-100%')}`);
      }

      let calculatedScore = 0;
      try {
        calculatedScore = evaluateFormula(indicator.formula, calculatedValue);
      } catch (err) {
        console.error(`❌ Lỗi tính công thức cho ${indicator.code}:`, err.message);
        calculatedScore = calculatedValue;
      }

      const scoreRes = await pool.query(
        `
        SELECT level, score_value, description
        FROM ScoringLevels
        WHERE indicator_id = $1 AND $2 >= min_value AND $2 <= max_value
        `,
        [indicator.indicator_id, calculatedValue]
      );
      const levelData = scoreRes.rows[0] || { level: 1, score_value: 0, description: 'Không có mô tả' };

      const newValues = { value, level: levelData.level, score_awarded: levelData.score_value || Math.round(calculatedScore), description: levelData.description };
      await pool.query(
        `
        UPDATE Assessments_Template
        SET value = $1, score_awarded = $2, date = CURRENT_DATE, assessor = $3
        WHERE assessment_id = $4
        `,
        [value, levelData.score_value || Math.round(calculatedScore), req.user.username, id]
      );

      await pool.query(
        `
        INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        ['Assessments_Template', id, JSON.stringify(oldValues), JSON.stringify(newValues), req.user.username, 'update', req.ip, req.get('User-Agent')]
      );

      res.redirect(`/dashboard?success=${encodeURIComponent('Cập nhật thành công')}`);
    } catch (err) {
      console.error('❌ Lỗi POST /edit_cndl:', err.message, err.stack);
      res.redirect(`/edit_cndl/${id}?error=${encodeURIComponent('Lỗi khi cập nhật dữ liệu')}`);
    }
  }
);
// Tuyến đường GET /total-score
app.get('/total-score', authenticateToken, async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'total-score.ejs');
    await fs.access(viewPath);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';
    const cacheKey = `total-score:${city}:${year}`;
    
    const data = await getCachedOrQuery(cacheKey, `
      SELECT 
        city AS district,
        ROUND(AVG(score_awarded) / 1000 * 100, 1) || '%' AS khi_hau,
        ROUND(AVG(score_awarded), 0) || '/1000' AS diem,
        CASE 
          WHEN AVG(score_awarded) >= 800 THEN 'Level 5'
          WHEN AVG(score_awarded) >= 600 THEN 'Level 4'
          WHEN AVG(score_awarded) >= 400 THEN 'Level 3'
          WHEN AVG(score_awarded) >= 200 THEN 'Level 2'
          ELSE 'Level 1'
        END AS level
      FROM Assessments_Template
      WHERE city = '${city}' AND year = ${year}
      GROUP BY city
    `);
    
    const updateDaysQuery = await pool.query(`
      SELECT COUNT(DISTINCT date) AS update_days
      FROM Assessments_Template
      WHERE city = '${city}' AND year = ${year}
    `);
    const updateDays = updateDaysQuery.rows[0]?.update_days || 0;
    
    const sampleData = data.length > 0 ? data : [
      { district: 'TP. Hồ Chí Minh', khi_hau: '87.5%', diem: '875/1000', level: 'Level 5' }
    ];
    
    res.render('total-score', {
      data: sampleData,
      user: req.user,
      error: req.query.error || null,
      success: req.query.success || null,
      selectedYear: year,
      years: [2023, 2024, 2025],
      updateDays
    });
  } catch (err) {
    console.error('❌ Lỗi trong route /total-score:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang tổng điểm hoặc lỗi khi tải dữ liệu',
      success: null,
    });
  }
});
// Tuyến đường GET /forgot-password
app.get('/forgot-password', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'forgot-password.ejs');
    await fs.access(viewPath);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.render('forgot-password', {
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('❌ Tệp forgot-password.ejs không tồn tại:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang quên mật khẩu',
      success: null
    });
  }
});

// Tuyến đường POST /forgot-password (tùy chọn, để xử lý form)
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    // Kiểm tra email trong cơ sở dữ liệu (giả định bảng Users)
    const result = await pool.query('SELECT * FROM Users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.redirect('/forgot-password?error=Email không tồn tại');
    }
    // TODO: Thêm logic gửi email đặt lại mật khẩu (dùng nodemailer)
    res.redirect('/forgot-password?success=Yêu cầu đặt lại mật khẩu đã được gửi');
  } catch (err) {
    console.error('❌ Lỗi xử lý yêu cầu quên mật khẩu:', err.message);
    res.redirect('/forgot-password?error=Có lỗi xảy ra, vui lòng thử lại');
  }
});
// Tuyến đường GET /reset-password
app.get('/reset-password', async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'reset-password.ejs');
    await fs.access(viewPath);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    
    const { token } = req.query;
    if (!token) {
      return res.redirect('/forgot-password?error=Token không hợp lệ');
    }

    // Xác minh token
    try {
      jwt.verify(token, process.env.JWT_SECRET);
      res.render('reset-password', {
        error: null,
        success: null,
        token
      });
    } catch (err) {
      return res.redirect('/forgot-password?error=Token không hợp lệ hoặc đã hết hạn');
    }
  } catch (err) {
    console.error('❌ Tệp reset-password.ejs không tồn tại:', err.message);
    res.status(500).render('error', {
      error: 'Không tìm thấy trang đặt lại mật khẩu',
      success: null
    });
  }
});

// Tuyến đường POST /reset-password
app.post('/reset-password', async (req, res) => {
  try {
    const { token, password, 'confirm-password': confirmPassword } = req.body;
    
    if (!token) {
      return res.redirect('/forgot-password?error=Token không hợp lệ');
    }
    
    if (password !== confirmPassword) {
      return res.redirect(`/reset-password?token=${token}&error=Mật khẩu xác nhận không khớp`);
    }

    // Xác minh token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.redirect('/forgot-password?error=Token không hợp lệ hoặc đã hết hạn');
    }

    // Kiểm tra email trong cơ sở dữ liệu
    const { email } = decoded;
    const result = await pool.query('SELECT * FROM Users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.redirect('/forgot-password?error=Email không tồn tại');
    }

    // Mã hóa mật khẩu mới
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE Users SET password = $1 WHERE email = $2', [hashedPassword, email]);

    res.redirect('/login?success=Mật khẩu đã được đặt lại thành công');
  } catch (err) {
    console.error('❌ Lỗi xử lý đặt lại mật khẩu:', err.message);
    res.redirect(`/reset-password?token=${req.body.token || ''}&error=Có lỗi xảy ra, vui lòng thử lại`);
  }
});
// Endpoint GET /qldl
app.get('/qldl', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    const assessmentsRes = await pool.query(
      `
      SELECT a.*, d.name AS domain_name, i.name AS indicator_name
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.year DESC, a.domain_id, a.indicator_id
      `,
      [city, year]
    );
    const yearsRes = await pool.query(
      'SELECT DISTINCT year FROM Assessments_Template WHERE city = $1 ORDER BY year DESC',
      [city]
    );
    const years = yearsRes.rows.map(row => row.year);

    res.render('qldl', {
      user,
      assessments: assessmentsRes.rows,
      years,
      selectedYear: year,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('Lỗi GET /qldl:', err);
    res.render('qldl', {
      user: req.user,
      assessments: [],
      years: [],
      selectedYear: null,
      error: 'Lỗi khi lấy dữ liệu',
      success: null,
    });
  }
});

app.post('/qldl/delete/:id', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const id = req.params.id;
    const oldQuery = await pool.query(
      `
      SELECT a.*, i.code
      FROM Assessments_Template a
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.assessment_id = $1
      `,
      [id]
    );
    if (oldQuery.rows.length === 0) return res.redirect('/qldl?error=Không tìm thấy mục');

    const oldValues = oldQuery.rows[0];
    await pool.query(
      `
      INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      ['Assessments_Template', id, JSON.stringify(oldValues), JSON.stringify({}), req.user.username, 'delete', req.ip, req.get('User-Agent')]
    );

    await pool.query('DELETE FROM Assessments_Template WHERE assessment_id = $1', [id]);
    res.redirect(`/qldl?success=${encodeURIComponent('Xóa thành công')}`);
  } catch (err) {
    console.error('Lỗi POST /qldl/delete:', err);
    res.redirect(`/qldl?error=${encodeURIComponent('Lỗi khi xóa dữ liệu')}`);
  }
});
app.get('/doimatkhau', authenticateToken, async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'doimatkhau.ejs');
    const errorViewPath = path.join(__dirname, 'views', 'error.ejs');
    
    // Check if doimatkhau.ejs exists
    try {
      await fs.access(viewPath);
    } catch (err) {
      console.error(`❌ Tệp doimatkhau.ejs không tồn tại tại: ${viewPath}`);
      // Check if error.ejs exists
      try {
        await fs.access(errorViewPath);
        return res.status(500).render('error', {
          user: req.user,
          error: 'Không tìm thấy giao diện đổi mật khẩu',
          success: null
        });
      } catch (err) {
        console.error(`❌ Tệp error.ejs không tồn tại tại: ${errorViewPath}`);
        return res.status(500).json({
          error: 'Không tìm thấy giao diện đổi mật khẩu hoặc trang lỗi',
          success: null
        });
      }
    }
    
    console.log(`✅ Truy cập /doimatkhau, user: ${req.user.username}`);
    res.render('doimatkhau', {
      user: req.user,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('❌ Lỗi GET /doimatkhau:', err.message, err.stack);
    try {
      await fs.access(path.join(__dirname, 'views', 'error.ejs'));
      res.status(500).render('error', {
        user: req.user,
        error: 'Lỗi server khi render trang đổi mật khẩu',
        success: null
      });
    } catch (err) {
      console.error(`❌ Tệp error.ejs không tồn tại tại: ${path.join(__dirname, 'views', 'error.ejs')}`);
      res.status(500).json({
        error: 'Lỗi server và không tìm thấy trang lỗi',
        success: null
      });
    }
  }
});

app.post(
  '/doimatkhau',
  authenticateToken,
  [
    body('oldPassword').trim().notEmpty().withMessage('Mật khẩu cũ không được để trống'),
    body('newPassword')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      .withMessage('Mật khẩu mới phải có ít nhất 8 ký tự, gồm chữ hoa, chữ thường, số và ký tự đặc biệt'),
    body('confirmPassword')
      .custom((value, { req }) => value === req.body.newPassword)
      .withMessage('Mật khẩu xác nhận không khớp')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.warn('⚠️ Lỗi validation /doimatkhau:', errors.array());
      return res.redirect(`/doimatkhau?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    const { oldPassword, newPassword } = req.body;
    const username = req.user.username;

    try {
      // Check user
      const result = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        console.warn(`⚠️ Không tìm thấy người dùng: ${username}`);
        return res.redirect(`/doimatkhau?error=${encodeURIComponent('Không tìm thấy người dùng')}`);
      }

      // Verify old password
      const user = result.rows[0];
      if (!bcrypt.compareSync(oldPassword, user.password)) {
        console.warn(`⚠️ Mật khẩu cũ không đúng cho người dùng: ${username}`);
        return res.redirect(`/doimatkhau?error=${encodeURIComponent('Mật khẩu cũ không đúng')}`);
      }

      // Hash new password
      const hashedNewPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedNewPassword, username]);

      // Log to edit_history
      await pool.query(
        `
        INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          'users',
          username,
          JSON.stringify({ password: '******' }), // Mask old password
          JSON.stringify({ password: '******' }), // Mask new password
          username,
          'update',
          req.ip,
          req.get('User-Agent')
        ]
      );

      console.log(`✅ Đổi mật khẩu thành công cho người dùng: ${username}`);
      res.redirect(`/doimatkhau?success=${encodeURIComponent('Đổi mật khẩu thành công')}`);
    } catch (err) {
      console.error('❌ Lỗi POST /doimatkhau:', err.message, err.stack);
      res.redirect(`/doimatkhau?error=${encodeURIComponent('Lỗi khi đổi mật khẩu')}`);
    }
  }
);

app.get('/xbtk', authenticateToken, async (req, res) => {
  res.render('xbtk', {
    user: req.user,
    error: req.query.error,
    success: req.query.success,
  });
});

app.post('/upload/pdf-to-word', authenticateToken, checkRole('admin'), upload.single('pdfFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.redirect('/xbtk?error=Không có file được tải lên');
    }
    const filePath = path.join(uploadDir, req.file.filename);
    await pool.query(
      `
      INSERT INTO file_uploads (filename, original_name, mimetype, size, uploaded_by, file_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user.username, filePath]
    );
    res.redirect('/xbtk?success=Tải file lên thành công');
  } catch (err) {
    console.error('Lỗi POST /upload/pdf-to-word:', err);
    res.redirect('/xbtk?error=Lỗi khi tải lên file');
  }
});

app.get('/export/excel', authenticateToken, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const assessmentsRes = await pool.query(
      `
      SELECT a.*, d.name AS domain_name, i.name AS indicator_name
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      `,
      ['TP. Hồ Chí Minh', year]
    );
    const data = assessmentsRes.rows;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Dữ liệu Climate Smart City');
    worksheet.columns = [
      { header: 'ID', key: 'assessment_id', width: 10 },
      { header: 'Năm', key: 'year', width: 10 },
      { header: 'Lĩnh vực', key: 'domain_name', width: 30 },
      { header: 'Chỉ số', key: 'indicator_name', width: 30 },
      { header: 'Giá trị', key: 'value', width: 15 },
      { header: 'Điểm', key: 'score_awarded', width: 10 },
      { header: 'Ngày cập nhật', key: 'date', width: 15 },
    ];
    worksheet.addRows(data);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="baocao.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Lỗi xuất Excel:', err);
    res.redirect('/dashboard?error=Lỗi khi xuất Excel');
  }
});

app.get('/export/pdf', authenticateToken, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const assessmentsRes = await pool.query(
      `
      SELECT a.*, d.name AS domain_name, i.name AS indicator_name
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      `,
      ['TP. Hồ Chí Minh', year]
    );
    const data = assessmentsRes.rows;

    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="baocao.pdf"');

    doc.pipe(res);
    doc.fontSize(20).text('Báo cáo Climate Smart City - TP. Hồ Chí Minh', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Tạo ngày: ${new Date().toLocaleString('vi-VN')}`);
    doc.moveDown();

    data.forEach((row, index) => {
      doc.fontSize(14).text(`Chỉ số: ${row.indicator_name}`, { underline: true });
      doc.fontSize(12).text(`Lĩnh vực: ${row.domain_name}`);
      doc.text(`Giá trị: ${row.value || 'N/A'}`);
      doc.text(`Điểm: ${row.score_awarded || 'N/A'}`);
      doc.text(`Ngày cập nhật: ${new Date(row.date).toLocaleDateString('vi-VN')}`);
      if (index < data.length - 1) doc.moveDown(2);
    });

    doc.end();
  } catch (err) {
    console.error('Lỗi xuất PDF:', err);
    res.redirect('/xbtk?error=Lỗi khi xuất PDF');
  }
});

app.get('/lichsu', authenticateToken, async (req, res) => {
  try {
    const user = req.user;
    const historyRes = await pool.query(
      `
      SELECT id, table_name, record_id, old_values, new_values, changed_by, timestamp
      FROM edit_history
      ORDER BY timestamp DESC
      LIMIT 100
      `
    );
    res.render('history', {
      user,
      history: historyRes.rows,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('Lỗi GET /lichsu:', err);
    res.render('history', {
      user: req.user,
      history: [],
      error: 'Lỗi khi lấy lịch sử',
      success: null,
    });
  }
});

app.get('/hsnd', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT username, role FROM users');
    const users = result.rows;
    res.render('hsnd', {
      user: req.user,
      users: users,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('❌ Lỗi GET /hsnd:', err.message);
    res.render('hsnd', {
      user: req.user,
      users: [],
      error: 'Lỗi khi lấy danh sách người dùng',
      success: null,
    });
  }
});

app.post(
  '/hsnd/update-role',
  authenticateToken,
  checkRole('admin'),
  [
    body('selectedUser').trim().notEmpty().withMessage('Vui lòng chọn người dùng'),
    body('newRole').isIn(['user', 'admin']).withMessage('Vai trò không hợp lệ'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.redirect(`/hsnd?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }
    const { selectedUser, newRole } = req.body;
    try {
      const oldQuery = await pool.query('SELECT username, role FROM users WHERE username = $1', [selectedUser]);
      if (oldQuery.rows.length === 0) {
        return res.redirect(`/hsnd?error=${encodeURIComponent('Không tìm thấy người dùng')}`);
      }
      const oldValues = oldQuery.rows[0];
      await pool.query('UPDATE users SET role = $1 WHERE username = $2', [newRole, selectedUser]);
      await pool.query(
        `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'users',
          selectedUser,
          JSON.stringify(oldValues),
          JSON.stringify({ username: selectedUser, role: newRole }),
          req.user.username,
          'update',
          req.ip,
          req.get('User-Agent'),
        ]
      );
      res.redirect(`/hsnd?success=${encodeURIComponent('Cập nhật vai trò thành công')}`);
    } catch (err) {
      console.error('❌ Lỗi POST /hsnd/update-role:', err.message);
      res.redirect(`/hsnd?error=${encodeURIComponent('Lỗi khi cập nhật vai trò')}`);
    }
  }
);

app.post('/refresh-token', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Không có token' });
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    const newToken = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', newToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
    res.json({ success: 'Làm mới token thành công' });
  } catch (err) {
    console.error('❌ Lỗi làm mới token:', err.message);
    res.clearCookie('token');
    res.status(401).json({ error: 'Token không hợp lệ' });
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/?success=Đăng xuất thành công');
});

// Khởi động server
(async () => {
  try {
    if (process.env.INIT_DB === 'true') {
      await initializeDatabase();
      console.log('✅ Cơ sở dữ liệu đã được khởi tạo.');
    } else {
      console.log('⏩ Bỏ qua khởi tạo cơ sở dữ liệu.');
    }
    await ensureConstraints();
  } catch (err) {
    console.error('❌ Lỗi khởi động server:', err);
    process.exit(1);
  }
})();

// Xuất Express app cho Vercel
// Xuất app cho Vercel
module.exports = app;

// Nếu chạy local thì dùng port 3000
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Local server running at http://localhost:${PORT}`);
  });
}
