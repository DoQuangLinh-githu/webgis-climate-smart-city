const express = require('express');
const app = express();
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
require('dotenv').config();

// Khởi tạo router
const router = express.Router();

// Cấu hình middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(express.static('public'));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Hàm parseRange (giữ nguyên từ mã gốc, không cần thay đổi nếu đã có)
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

// Hàm calculateIndicator (tích hợp từ mã mới)
async function calculateIndicator(indicatorCode, params) {
  let value, level, score, description;

  try {
    // Lấy thông tin chỉ số từ bảng Indicators
    const indicatorRes = await pool.query(
      'SELECT unit_code FROM Indicators WHERE code = $1',
      [indicatorCode]
    );
    if (indicatorRes.rows.length === 0) {
      throw new Error('Chỉ số không được hỗ trợ');
    }
    const { unit_code } = indicatorRes.rows[0];

    switch (indicatorCode) {
      case 'ENI_RWE':
        const { E_RE, EC, L_ATC, P_RE, P_total } = params;
        if (EC - L_ATC === 0 || P_total === 0) throw new Error('Không thể chia cho 0');
        value = ((E_RE - L_ATC) / EC * 100 + P_RE / P_total * 100) || 0; // Công thức gốc
        break;

      case 'SENIRE':
        const { SE_RE, ES } = params;
        if (ES === 0) throw new Error('Không thể chia cho 0');
        value = (SE_RE / ES * 100) || 0;
        break;

      case 'EI_Save':
        const { E_Save, E_C } = params;
        if (E_C === 0) throw new Error('Không thể chia cho 0');
        value = (E_Save / E_C * 100) || 0;
        break;

      case 'EI_LR':
        const { E_delivered, E_input } = params;
        if (E_input === 0) throw new Error('Không thể chia cho 0');
        value = (E_delivered / E_input * 100) || 0;
        break;

      case 'SLI':
        const { SL_e, SL_s, SL } = params;
        if (SL === 0) throw new Error('Không thể chia cho 0');
        value = ((SL_e + SL_s) / SL * 100) || 0;
        break;

      case 'GBpromo':
        value = parseFloat(params.GBpromo) || 0;
        break;

      case 'VNGBI':
        const { B_P, B_AC, S_GB, S_BC } = params;
        if (S_BC === 0) throw new Error('Không thể chia cho 0');
        value = ((B_P + B_AC) / (S_GB / S_BC) * 100) || 0;
        break;

      case 'R_CO2e':
        const { CO2eb, CO2et } = params;
        if (CO2eb === 0) throw new Error('Không thể chia cho 0');
        value = ((CO2eb - CO2et) / CO2eb * 100) || 0;
        break;

      case 'R_S_water':
        const { S_water_present, S_op_present, S_water_plan, S_op_plan } = params;
        if (S_water_plan + S_op_plan === 0) throw new Error('Không thể chia cho 0');
        value = ((S_water_present + S_op_present) / (S_water_plan + S_op_plan) * 100) || 0;
        break;

      case 'Rcover':
        const { S_pp, P } = params;
        if (P === 0) throw new Error('Không thể chia cho 0');
        value = ((S_pp / P) / 12 * 100) || 0;
        break;

      case 'Rland_p':
        const { S_land_p, S_total_land } = params;
        if (S_total_land === 0) throw new Error('Không thể chia cho 0');
        value = (S_land_p / S_total_land * 100) || 0;
        break;

      case 'UBI_PNRA':
        const { A_natural, A_restored, A_city } = params;
        if (A_city === 0) throw new Error('Không thể chia cho 0');
        value = ((A_natural + A_restored) / A_city * 100) || 0;
        break;

      case 'GISapp':
        value = parseFloat(params.GISapp) || 0;
        break;

      case 'DISaster':
        value = parseFloat(params.DISaster) || 0;
        break;

      case 'ClimateAct':
        value = parseFloat(params.ClimateAct) || 0;
        break;

      case 'NMT':
        const { NMT_L, L_R } = params;
        if (L_R === 0) throw new Error('Không thể chia cho 0');
        value = (NMT_L / L_R * 100) || 0;
        break;

      case 'PT_c':
        const { PT_c, PT } = params;
        if (PT === 0) throw new Error('Không thể chia cho 0');
        value = (PT_c / PT * 100) || 0;
        break;

      case 'PT1000':
        const { PT_F, P } = params;
        if (P === 0) throw new Error('Không thể chia cho 0');
        value = (PT_F * 1000 / P) || 0;
        break;

      case 'STL':
        const { STL_S, TL } = params;
        if (TL === 0) throw new Error('Không thể chia cho 0');
        value = (STL_S / TL * 100) || 0;
        break;

      case 'SRRW':
        const { SRRW_L, TSR } = params;
        if (TSR === 0) throw new Error('Không thể chia cho 0');
        value = (SRRW_L / TSR * 100) || 0;
        break;

      case 'RoadCap':
        value = parseFloat(params.RoadCap) || 0;
        break;

      case 'AQstation':
        const { AQstation, A_city } = params;
        if (A_city === 0) throw new Error('Không thể chia cho 0');
        value = (AQstation / A_city) || 0;
        break;

      case 'AQdata':
        value = parseFloat(params.AQdata) || 0;
        break;

      case 'CleanAirPlan':
        value = parseFloat(params.CleanAirPlan) || 0;
        break;

      case 'AQI_TDE':
        value = parseFloat(params.AQI_exceed_days) || 0;
        break;

      case 'WImanage':
        value = parseFloat(params.WImanage) || 0;
        break;

      case 'WI_loss':
        const { W_P, W_S } = params;
        if (W_P === 0) throw new Error('Không thể chia cho 0');
        value = ((W_P - W_S) / W_P * 100) || 0;
        break;

      case 'WI_rr':
        const { W_rr, W_s } = params;
        if (W_s === 0) throw new Error('Không thể chia cho 0');
        value = (W_rr / W_s * 100) || 0;
        break;

      case 'FloodRisk':
        value = parseFloat(params.FloodRisk) || 0;
        break;

      case 'Ewater':
        value = parseFloat(params.Ewater) || 0;
        break;

      case 'Ewwater':
        value = parseFloat(params.Ewwater) || 0;
        break;

      case 'DigWater':
        value = parseFloat(params.DigWater) || 0;
        break;

      case 'R_USWA':
        const { P_W, P_S } = params;
        if (P_S === 0) throw new Error('Không thể chia cho 0');
        value = (P_W / P_S * 100) || 0;
        break;

      case 'WasteInit':
        value = parseFloat(params.Waste_Init) || 0;
        break;

      case 'R_USWA_waste':
        const { W_landfill, W_waste_generate } = params;
        if (W_waste_generate === 0) throw new Error('Không thể chia cho 0');
        value = (W_landfill / W_waste_generate * 100) || 0;
        break;

      case 'RRWI':
        const { W_RU, W_RRC, W_G } = params;
        if (W_G === 0) throw new Error('Không thể chia cho 0');
        value = ((W_RU + W_RRC) / W_G * 100) || 0;
        break;

      case 'ConsWaste':
        const { W_Cons_deli_cp, W_Cons_rr, W_Cons_deli_reduce, W_Cons } = params;
        if (W_Cons === 0) throw new Error('Không thể chia cho 0');
        value = ((W_Cons_deli_cp + W_Cons_rr + W_Cons_deli_reduce) / W_Cons * 100) || 0;
        break;

      case 'WWT_I':
        const { W_T, W_G: W_G_WWT } = params;
        if (W_G_WWT === 0) throw new Error('Không thể chia cho 0');
        value = (W_T / W_G_WWT * 100) || 0;
        break;

      case 'DigWaste':
        value = parseFloat(params.DigWaste) || 0;
        break;

      case 'LandfillEff':
        value = parseFloat(params.LandfillEff) || 0;
        break;

      case 'GHGIs':
        value =
          (parseFloat(params.GHGs_Landfill) || 0) +
          (parseFloat(params.GHGs_WTE) || 0) +
          (parseFloat(params.GHGs_Recycling) || 0) +
          (parseFloat(params.GHGs_Composting) || 0);
        break;

      default:
        throw new Error('Chỉ số không được hỗ trợ');
    }

    // Giới hạn giá trị phần trăm (nếu unit_code là percent)
    if (unit_code === 'percent' && (value < 0 || value > 100)) {
      console.warn(`Giá trị cho ${indicatorCode} phải từ 0-100%, nhận được: ${value}`);
      value = Math.max(0, Math.min(100, value));
    }

    // Lấy mức độ và điểm số từ bảng ScoringLevels
    const levelsRes = await pool.query(
      'SELECT criteria, level, score_value, description FROM ScoringLevels WHERE indicator_code = $1',
      [indicatorCode]
    );
    let selectedLevel = { level: 'Không xác định', score_value: 0, description: 'Không có mô tả' };
    for (const levelRow of levelsRes.rows) {
      const { min_value, max_value } = parseRange(levelRow.criteria);
      if ((min_value === null || value >= min_value) && (max_value === null || value <= max_value)) {
        selectedLevel = {
          level: levelRow.level,
          score_value: levelRow.score_value,
          description: levelRow.description,
        };
        break;
      }
    }

    return {
      value: value.toFixed(2),
      level: selectedLevel.level,
      score: selectedLevel.score_value,
      description: selectedLevel.description,
    };
  } catch (error) {
    console.error(`Lỗi khi tính chỉ số ${indicatorCode}:`, error.message);
    throw error;
  }
}

// Middleware authenticateToken và checkRole (giữ nguyên nếu đã có)
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

function checkRole(role) {
  return (req, res, next) => {
    if (req.user && req.user.role === role) {
      next();
    } else {
      res.redirect('/?error=Không có quyền truy cập');
    }
  };
}

// Hàm getCachedOrQuery (từ mã gốc, giữ nguyên nếu đã có)
async function getCachedOrQuery(cacheKey, query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result.rows;
  } catch (err) {
    console.error(`Lỗi truy vấn ${cacheKey}:`, err.message);
    throw err;
  }
}

// Hàm initializeDatabase (từ mã gốc, giữ nguyên)
async function initializeDatabase() {
  try {
    // Tạo bảng Domains
    await pool.query(`
      CREATE TABLE IF NOT EXISTS Domains (
        domain_id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT
      );
    `);

    // Tạo bảng Indicators
    await pool.query(`
      CREATE TABLE IF NOT EXISTS Indicators (
        indicator_id SERIAL PRIMARY KEY,
        domain_id INTEGER REFERENCES Domains(domain_id),
        name VARCHAR(255) NOT NULL,
        code VARCHAR(50) UNIQUE NOT NULL,
        unit_code VARCHAR(50),
        max_score INTEGER DEFAULT 12,
        description TEXT
      );
    `);

    // Tạo bảng ScoringLevels
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ScoringLevels (
        id SERIAL PRIMARY KEY,
        indicator_code VARCHAR(50) REFERENCES Indicators(code),
        criteria VARCHAR(100),
        level VARCHAR(50),
        score_value INTEGER,
        description TEXT
      );
    `);

    // Tạo bảng Assessments_Template
    await pool.query(`
      CREATE TABLE IF NOT EXISTS Assessments_Template (
        id SERIAL PRIMARY KEY,
        city VARCHAR(100) NOT NULL,
        year INTEGER NOT NULL,
        domain_id INTEGER REFERENCES Domains(domain_id),
        indicator_id INTEGER REFERENCES Indicators(indicator_id),
        indicator_code VARCHAR(50) REFERENCES Indicators(code),
        value VARCHAR(50),
        unit_code VARCHAR(50),
        score_awarded INTEGER,
        assessor VARCHAR(100),
        date DATE,
        level VARCHAR(50),
        description TEXT,
        UNIQUE(city, year, indicator_code)
      );
    `);

    // Tạo bảng users
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL
      );
    `);

    // Tạo bảng file_uploads
    await pool.query(`
      CREATE TABLE IF NOT EXISTS file_uploads (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        original_name VARCHAR(255) NOT NULL,
        mimetype VARCHAR(100),
        size INTEGER,
        uploaded_by VARCHAR(100),
        file_path VARCHAR(255) NOT NULL,
        upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tạo bảng edit_history
    await pool.query(`
      CREATE TABLE IF NOT EXISTS edit_history (
        id SERIAL PRIMARY KEY,
        table_name VARCHAR(100),
        record_id VARCHAR(255),
        old_values JSONB,
        new_values JSONB,
        changed_by VARCHAR(100),
        change_type VARCHAR(50),
        ip_address VARCHAR(50),
        user_agent TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Chèn dữ liệu mẫu vào Domains
    await pool.query(`
      INSERT INTO Domains (domain_id, name, description) VALUES
      (1, 'Năng lượng', 'Các chỉ số liên quan đến năng lượng và hiệu quả năng lượng'),
      (2, 'Môi trường và khí hậu', 'Các chỉ số về môi trường, giảm phát thải và thích ứng khí hậu'),
      (3, 'Giao thông vận tải', 'Các chỉ số về giao thông và chất lượng không khí'),
      (4, 'Nguồn nước', 'Các chỉ số về quản lý và sử dụng nước'),
      (5, 'Quản lý chất thải', 'Các chỉ số về quản lý chất thải và tái chế')
      ON CONFLICT (domain_id) DO NOTHING;
    `);

    // Chèn dữ liệu mẫu vào Indicators
    await pool.query(`
      INSERT INTO Indicators (indicator_id, domain_id, name, code, unit_code, max_score, description) VALUES
      (1, 1, 'Tỷ lệ tiêu thụ điện từ các nguồn năng lượng tái tạo', 'ENI_RWE', 'percent', 12, 'Đo lường tỷ lệ điện tiêu thụ từ các nguồn tái tạo'),
      (2, 1, 'Tỷ lệ năng lượng tái tạo trong tổng nguồn cung năng lượng sơ cấp', 'SENIRE', 'percent', 12, 'Đo lường tỷ lệ năng lượng tái tạo trong tổng cung'),
      (3, 1, 'Chỉ số tiết kiệm điện', 'EI_Save', 'kWh or percent', 12, 'Đo lường hiệu quả tiết kiệm điện năng'),
      (4, 1, 'Hiệu quả truyền tải điện năng', 'EI_LR', 'percent', 12, 'Đo lường hiệu quả truyền tải điện'),
      (5, 1, 'Tỷ lệ đèn LED thông minh', 'SLI', 'percent or count', 12, 'Đo lường tỷ lệ sử dụng đèn LED thông minh'),
      (6, 1, 'Đánh giá thúc đẩy công trình xanh', 'GBpromo', 'score', 12, 'Đánh giá các chương trình thúc đẩy công trình xanh'),
      (7, 1, 'Tỷ lệ công trình xanh được chứng nhận', 'VNGBI', 'percent or area', 12, 'Đo lường tỷ lệ công trình xanh đạt chứng nhận'),
      (8, 2, 'Giảm phát thải CO2 tương đương', 'R_CO2e', 'percent', 12, 'Đo lường mức giảm phát thải CO2'),
      (9, 2, 'Tỷ lệ tiết kiệm nước bề mặt', 'R_S_water', 'percent', 12, 'Đo lường tỷ lệ tiết kiệm nước bề mặt'),
      (10, 2, 'Diện tích xanh bình quân đầu người', 'Rcover', 'm2/person', 12, 'Đo lường diện tích xanh bình quân'),
      (11, 2, 'Tỷ lệ đất xanh', 'Rland_p', 'percent', 12, 'Đo lường tỷ lệ đất dành cho không gian xanh'),
      (12, 2, 'Chỉ số không gian xanh đô thị', 'UBI_PNRA', 'percent', 12, 'Đo lường không gian xanh đô thị'),
      (13, 2, 'Ứng dụng GIS', 'GISapp', 'score', 12, 'Đánh giá mức độ ứng dụng GIS'),
      (14, 2, 'Ứng dụng công nghệ trong quản lý thiên tai', 'DISaster', 'score', 12, 'Đánh giá công nghệ quản lý thiên tai'),
      (15, 2, 'Kế hoạch hành động khí hậu', 'ClimateAct', 'score', 12, 'Đánh giá kế hoạch hành động khí hậu'),
      (16, 3, 'Tỷ lệ phương tiện giao thông không phát thải', 'NMT', 'percent', 12, 'Đo lường tỷ lệ phương tiện không phát thải'),
      (17, 3, 'Tỷ lệ vận tải công cộng', 'PT_c', 'percent', 12, 'Đo lường tỷ lệ sử dụng vận tải công cộng'),
      (18, 3, 'Số lượng phương tiện vận tải công cộng trên 1000 dân', 'PT1000', 'vehicles per 1000 or score', 12, 'Đo lường số lượng phương tiện công cộng'),
      (19, 3, 'Tỷ lệ đường phố có đèn LED', 'STL', 'percent', 12, 'Đo lường tỷ lệ đường phố sử dụng đèn LED'),
      (20, 3, 'Tỷ lệ đường sắt đô thị', 'SRRW', 'percent', 12, 'Đo lường tỷ lệ đường sắt đô thị'),
      (21, 3, 'Tỷ lệ đường giao thông thông thoáng', 'RoadCap', 'score', 12, 'Đo lường mức độ thông thoáng của đường giao thông'),
      (22, 3, 'Mật độ trạm quan trắc không khí', 'AQstation', 'stations per area', 12, 'Đo lường mật độ trạm quan trắc không khí'),
      (23, 3, 'Công bố dữ liệu chất lượng không khí', 'AQdata', 'score', 12, 'Đánh giá mức độ công bố dữ liệu không khí'),
      (24, 3, 'Kế hoạch cải thiện chất lượng không khí', 'CleanAirPlan', 'score', 12, 'Đánh giá kế hoạch cải thiện không khí'),
      (25, 3, 'Số ngày vượt chuẩn AQI', 'AQI_TDE', 'days', 12, 'Đo lường số ngày vượt chuẩn chất lượng không khí'),
      (26, 4, 'Quản lý tài nguyên nước', 'WImanage', 'score', 12, 'Đánh giá quản lý tài nguyên nước'),
      (27, 4, 'Tỷ lệ thất thoát nước', 'WI_loss', 'percent', 12, 'Đo lường tỷ lệ thất thoát nước'),
      (28, 4, 'Tỷ lệ tái sử dụng nước', 'WI_rr', 'percent', 12, 'Đo lường tỷ lệ tái sử dụng nước'),
      (29, 4, 'Rủi ro ngập lụt', 'FloodRisk', 'score', 12, 'Đánh giá rủi ro ngập lụt'),
      (30, 4, 'Hiệu quả năng lượng trong cung cấp nước', 'Ewater', 'score', 12, 'Đo lường hiệu quả năng lượng cung cấp nước'),
      (31, 4, 'Hiệu quả năng lượng trong xử lý nước thải', 'Ewwater', 'score', 12, 'Đo lường hiệu quả năng lượng xử lý nước thải'),
      (32, 4, 'Ứng dụng công nghệ số trong quản lý nước', 'DigWater', 'score', 12, 'Đánh giá ứng dụng công nghệ số quản lý nước'),
      (33, 4, 'Tỷ lệ dân số tiếp cận nước sạch', 'R_USWA', 'percent', 12, 'Đo lường tỷ lệ dân số tiếp cận nước sạch'),
      (34, 5, 'Sáng kiến quản lý chất thải', 'WasteInit', 'score', 12, 'Đánh giá sáng kiến quản lý chất thải'),
      (35, 5, 'Tỷ lệ chất thải chôn lấp', 'R_USWA_waste', 'percent', 12, 'Đo lường tỷ lệ chất thải chôn lấp'),
      (36, 5, 'Tỷ lệ tái chế chất thải', 'RRWI', 'percent', 12, 'Đo lường tỷ lệ tái chế chất thải'),
      (37, 5, 'Xử lý chất thải xây dựng', 'ConsWaste', 'score', 12, 'Đánh giá xử lý chất thải xây dựng'),
      (38, 5, 'Tỷ lệ xử lý nước thải', 'WWT_I', 'percent or ton', 12, 'Đo lường tỷ lệ xử lý nước thải'),
      (39, 5, 'Ứng dụng công nghệ số trong quản lý chất thải', 'DigWaste', 'score', 12, 'Đánh giá ứng dụng công nghệ số quản lý chất thải'),
      (40, 5, 'Hiệu quả bãi chôn lấp', 'LandfillEff', 'score', 12, 'Đánh giá hiệu quả bãi chôn lấp'),
      (41, 5, 'Phát thải khí nhà kính từ chất thải', 'GHGIs', 'tCO2e/year', 12, 'Đo lường phát thải khí nhà kính từ chất thải')
      ON CONFLICT (code) DO NOTHING;
    `);

    // Chèn dữ liệu mẫu vào ScoringLevels
    await pool.query(`
      INSERT INTO ScoringLevels (indicator_code, criteria, level, score_value, description) VALUES
      ('ENI_RWE', '0-20', 'Mức 1', 3, 'Tỷ lệ năng lượng tái tạo dưới 20%'),
      ('ENI_RWE', '20-40', 'Mức 2', 6, 'Tỷ lệ năng lượng tái tạo từ 20% đến dưới 40%'),
      ('ENI_RWE', '40-60', 'Mức 3', 9, 'Tỷ lệ năng lượng tái tạo từ 40% đến dưới 60%'),
      ('ENI_RWE', '60-80', 'Mức 4', 12, 'Tỷ lệ năng lượng tái tạo từ 60% đến dưới 80%'),
      ('ENI_RWE', '>=80', 'Mức 5', 15, 'Tỷ lệ năng lượng tái tạo từ 80% trở lên'),
      ('SENIRE', '0-20', 'Mức 1', 3, 'Tỷ lệ năng lượng tái tạo trong tổng cung dưới 20%'),
      ('SENIRE', '20-40', 'Mức 2', 6, 'Tỷ lệ năng lượng tái tạo trong tổng cung từ 20% đến dưới 40%'),
      ('SENIRE', '40-60', 'Mức 3', 9, 'Tỷ lệ năng lượng tái tạo trong tổng cung từ 40% đến dưới 60%'),
      ('SENIRE', '60-80', 'Mức 4', 12, 'Tỷ lệ năng lượng tái tạo trong tổng cung từ 60% đến dưới 80%'),
      ('SENIRE', '>=80', 'Mức 5', 15, 'Tỷ lệ năng lượng tái tạo trong tổng cung từ 80% trở lên'),
      ('EI_Save', '0-10', 'Mức 1', 3, 'Tỷ lệ tiết kiệm điện dưới 10%'),
      ('EI_Save', '10-20', 'Mức 2', 6, 'Tỷ lệ tiết kiệm điện từ 10% đến dưới 20%'),
      ('EI_Save', '20-30', 'Mức 3', 9, 'Tỷ lệ tiết kiệm điện từ 20% đến dưới 30%'),
      ('EI_Save', '30-40', 'Mức 4', 12, 'Tỷ lệ tiết kiệm điện từ 30% đến dưới 40%'),
      ('EI_Save', '>=40', 'Mức 5', 15, 'Tỷ lệ tiết kiệm điện từ 40% trở lên'),
      ('GBpromo', '0-2', 'Mức 1', 3, 'Chưa có chương trình thúc đẩy công trình xanh'),
      ('GBpromo', '3-5', 'Mức 2', 6, 'Có chương trình cơ bản'),
      ('GBpromo', '6-8', 'Mức 3', 9, 'Có chương trình nâng cao'),
      ('GBpromo', '9-10', 'Mức 4', 12, 'Có chương trình toàn diện'),
      ('GBpromo', '>=11', 'Mức 5', 15, 'Chương trình xuất sắc, đạt chuẩn quốc tế')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Chèn dữ liệu mẫu vào Assessments_Template
    await pool.query(`
      INSERT INTO Assessments_Template (city, year, domain_id, indicator_id, indicator_code, value, unit_code, score_awarded, assessor, date, level, description)
      VALUES
      ('TP. Hồ Chí Minh', 2025, 1, 1, 'ENI_RWE', '75.5', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ năng lượng tái tạo từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 1, 2, 'SENIRE', '65.2', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ năng lượng tái tạo trong tổng cung từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 1, 3, 'EI_Save', '25.0', 'kWh or percent', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ tiết kiệm điện từ 20% đến dưới 30%'),
      ('TP. Hồ Chí Minh', 2025, 1, 4, 'EI_LR', '70.0', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Hiệu quả truyền tải điện từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 1, 5, 'SLI', '80.0', 'percent or count', 15, 'admin', '2025-10-01', 'Mức 5', 'Tỷ lệ đèn LED thông minh từ 80% trở lên'),
      ('TP. Hồ Chí Minh', 2025, 1, 6, 'GBpromo', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Có chương trình nâng cao'),
      ('TP. Hồ Chí Minh', 2025, 1, 7, 'VNGBI', '50.0', 'percent or area', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ công trình xanh đạt chứng nhận từ 40% đến dưới 60%'),
      ('TP. Hồ Chí Minh', 2025, 2, 8, 'R_CO2e', '60.0', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Mức giảm phát thải CO2 từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 2, 9, 'R_S_water', '55.0', 'percent', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ tiết kiệm nước bề mặt từ 40% đến dưới 60%'),
      ('TP. Hồ Chí Minh', 2025, 2, 10, 'Rcover', '40.0', 'm2/person', 9, 'admin', '2025-10-01', 'Mức 3', 'Diện tích xanh bình quân từ 30 đến dưới 50 m2/người'),
      ('TP. Hồ Chí Minh', 2025, 2, 11, 'Rland_p', '45.0', 'percent', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ đất xanh từ 40% đến dưới 60%'),
      ('TP. Hồ Chí Minh', 2025, 2, 12, 'UBI_PNRA', '30.0', 'percent', 6, 'admin', '2025-10-01', 'Mức 2', 'Chỉ số không gian xanh đô thị từ 20% đến dưới 40%'),
      ('TP. Hồ Chí Minh', 2025, 2, 13, 'GISapp', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Phân tích không gian nâng cao (dữ liệu số hóa 75–90%)'),
      ('TP. Hồ Chí Minh', 2025, 2, 14, 'DISaster', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Áp dụng AI, IoT, mật độ trạm >2 trạm/100 km²'),
      ('TP. Hồ Chí Minh', 2025, 2, 15, 'ClimateAct', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Kế hoạch giảm phát thải trung hạn (Net Zero 2045–2050)'),
      ('TP. Hồ Chí Minh', 2025, 3, 16, 'NMT', '50.0', 'percent', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ phương tiện không phát thải từ 40% đến dưới 60%'),
      ('TP. Hồ Chí Minh', 2025, 3, 17, 'PT_c', '60.0', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ vận tải công cộng từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 3, 18, 'PT1000', '150', 'vehicles per 1000 or score', 9, 'admin', '2025-10-01', 'Mức 3', 'Số lượng phương tiện công cộng từ 100 đến dưới 200 xe/1000 dân'),
      ('TP. Hồ Chí Minh', 2025, 3, 19, 'STL', '70.0', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ đường phố có đèn LED từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 3, 20, 'SRRW', '65.0', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ đường sắt đô thị từ 60% đến dưới 80%'),
      ('TP. Hồ Chí Minh', 2025, 3, 21, 'RoadCap', '80', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ đường thông thoáng từ 75% đến dưới 90%'),
      ('TP. Hồ Chí Minh', 2025, 3, 22, 'AQstation', '15', 'stations per area', 9, 'admin', '2025-10-01', 'Mức 3', 'Mật độ trạm quan trắc từ 10 đến dưới 20 trạm'),
      ('TP. Hồ Chí Minh', 2025, 3, 23, 'AQdata', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Công bố dữ liệu đa thông số theo quy định'),
      ('TP. Hồ Chí Minh', 2025, 3, 24, 'CleanAirPlan', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Kế hoạch cải thiện chất lượng không khí toàn diện'),
      ('TP. Hồ Chí Minh', 2025, 3, 25, 'AQI_TDE', '70', 'days', 9, 'admin', '2025-10-01', 'Mức 3', 'Số ngày vượt chuẩn AQI từ 50 đến dưới 100 ngày'),
      ('TP. Hồ Chí Minh', 2025, 4, 26, 'WImanage', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Quản lý tài nguyên nước toàn diện'),
      ('TP. Hồ Chí Minh', 2025, 4, 27, 'WI_loss', '15', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ thất thoát nước từ 10% đến dưới 20%'),
      ('TP. Hồ Chí Minh', 2025, 4, 28, 'WI_rr', '20', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ tái sử dụng nước từ 15% đến dưới 30%'),
      ('TP. Hồ Chí Minh', 2025, 4, 29, 'FloodRisk', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Hệ thống cảm biến ngập lụt toàn diện'),
      ('TP. Hồ Chí Minh', 2025, 4, 30, 'Ewater', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Hiệu quả năng lượng cung cấp nước từ 10% đến dưới 20%'),
      ('TP. Hồ Chí Minh', 2025, 4, 31, 'Ewwater', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Hiệu quả năng lượng xử lý nước thải từ 10% đến dưới 20%'),
      ('TP. Hồ Chí Minh', 2025, 4, 32, 'DigWater', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Giám sát từ xa bằng SCADA từ 50% đến dưới 70%'),
      ('TP. Hồ Chí Minh', 2025, 4, 33, 'R_USWA', '90', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ dân số tiếp cận nước sạch từ 90% đến dưới 100%'),
      ('TP. Hồ Chí Minh', 2025, 5, 34, 'WasteInit', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Có sáng kiến quản lý chất thải cơ bản'),
      ('TP. Hồ Chí Minh', 2025, 5, 35, 'R_USWA_waste', '30', 'percent', 12, 'admin', '2025-10-01', 'Mức 4', 'Tỷ lệ chất thải chôn lấp từ 20% đến dưới 40%'),
      ('TP. Hồ Chí Minh', 2025, 5, 36, 'RRWI', '15', 'percent', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ tái chế chất thải từ 10% đến dưới 20%'),
      ('TP. Hồ Chí Minh', 2025, 5, 37, 'ConsWaste', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Có xử lý chất thải xây dựng cơ bản'),
      ('TP. Hồ Chí Minh', 2025, 5, 38, 'WWT_I', '50', 'percent or ton', 9, 'admin', '2025-10-01', 'Mức 3', 'Tỷ lệ xử lý nước thải từ 50% đến dưới 75%'),
      ('TP. Hồ Chí Minh', 2025, 5, 39, 'DigWaste', '6', 'score', 9, 'admin', '2025-10-01', 'Mức 3', 'Quản lý chất thải số hóa từ 50% đến dưới 75%'),
      ('TP. Hồ Chí Minh', 2025, 5, 40, 'LandfillEff', '9', 'score', 12, 'admin', '2025-10-01', 'Mức 4', 'Bãi chôn lấp vận hành theo quy định'),
      ('TP. Hồ Chí Minh', 2025, 5, 41, 'GHGIs', '50', 'tCO2e/year', 12, 'admin', '2025-10-01', 'Mức 4', 'Phát thải khí nhà kính từ chất thải từ 50% đến dưới 75%')
      ON CONFLICT (city, year, indicator_code) DO NOTHING;
    `);

    // Thêm người dùng admin mặc định
    await pool.query(`
      INSERT INTO users (username, password, role) VALUES
      ('admin', '${await bcrypt.hash('admin123', 10)}', 'admin')
      ON CONFLICT (username) DO NOTHING;
    `);

    console.log('✅ Cơ sở dữ liệu đã được khởi tạo thành công!');
  } catch (err) {
    console.error('❌ Lỗi khi khởi tạo cơ sở dữ liệu:', err.message);
    throw err;
  }
}

// Gọi hàm khởi tạo cơ sở dữ liệu
initializeDatabase().catch((err) => {
  console.error('❌ Không thể khởi tạo cơ sở dữ liệu:', err.message);
  process.exit(1);
});

// Endpoint preview
router.post('/cndl/preview', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const { indicatorCode, params, year, city } = req.body;

    // Validate input
    if (!indicatorCode || !params || !year || !city) {
      return res.status(400).json({ message: 'Thiếu thông tin cần thiết' });
    }

    // Calculate indicator
    const result = await calculateIndicator(indicatorCode, params);

    res.json(result);
  } catch (error) {
    console.error('Error in /cndl/preview:', error.message);
    res.status(500).json({ message: `Lỗi server khi tính toán chỉ số: ${error.message}` });
  }
});

// Tích hợp router vào app
app.use('/', router);

// Route GET /
app.get('/', (req, res) => {
  const error = req.query.error || '';
  const success = req.query.success || '';
  res.render('index', { error, success });
});

// Route POST /login
app.post(
  '/login',
  [
    body('username').notEmpty().withMessage('Tên người dùng không được để trống'),
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
      const user = result.rows[0];

      if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.redirect('/?error=Sai tên người dùng hoặc mật khẩu');
      }

      const token = jwt.sign({ username: user.username, role: user.role }, process.env.JWT_SECRET, {
        expiresIn: '1d',
      });
      res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Lỗi đăng nhập:', err.message);
      res.redirect(`/?error=${encodeURIComponent('Lỗi hệ thống, vui lòng thử lại')}`);
    }
  }
);

// Route GET /dashboard
app.get('/dashboard', authenticateToken, async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const city = req.query.city || 'TP. Hồ Chí Minh';
  const success = req.query.success || '';
  const error = req.query.error || '';

  try {
    const assessments = await getCachedOrQuery(
      `assessments_${city}_${year}`,
      `SELECT a.*, i.name AS indicator_name, d.name AS domain_name
       FROM Assessments_Template a
       JOIN Indicators i ON a.indicator_id = i.indicator_id
       JOIN Domains d ON a.domain_id = d.domain_id
       WHERE a.city = $1 AND a.year = $2
       ORDER BY a.domain_id, a.indicator_id`,
      [city, year]
    );

    // Tính tổng điểm theo domain
    const domainScores = {};
    const domainMaxScores = {};
    for (const assessment of assessments) {
      const domainId = assessment.domain_id;
      if (!domainScores[domainId]) {
        domainScores[domainId] = 0;
        domainMaxScores[domainId] = 0;
      }
      domainScores[domainId] += assessment.score_awarded || 0;
      const maxScoreRes = await pool.query('SELECT max_score FROM Indicators WHERE indicator_id = $1', [
        assessment.indicator_id,
      ]);
      domainMaxScores[domainId] += maxScoreRes.rows[0]?.max_score || 0;
    }

    res.render('dashboard', {
      assessments,
      domainScores,
      domainMaxScores,
      year,
      city,
      user: req.user,
      success,
      error,
    });
  } catch (err) {
    console.error('Lỗi GET /dashboard:', err.message);
    res.render('dashboard', {
      assessments: [],
      domainScores: {},
      domainMaxScores: {},
      year,
      city,
      user: req.user,
      error: 'Lỗi khi tải dữ liệu dashboard',
      success: '',
    });
  }
});

// Route GET /cndl
app.get('/cndl', authenticateToken, checkRole('admin'), async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const city = req.query.city || 'TP. Hồ Chí Minh';
  const error = req.query.error || '';
  const success = req.query.success || '';

  try {
    const indicators = await getCachedOrQuery(
      'indicators_all',
      `SELECT i.*, d.name AS domain_name
       FROM Indicators i
       JOIN Domains d ON i.domain_id = d.domain_id
       ORDER BY d.domain_id, i.indicator_id`
    );

    const assessments = await getCachedOrQuery(
      `assessments_${city}_${year}`,
      `SELECT * FROM Assessments_Template WHERE city = $1 AND year = $2`,
      [city, year]
    );

    res.render('cndl', {
      indicators,
      assessments,
      year,
      city,
      error,
      success,
      user: req.user,
    });
  } catch (err) {
    console.error('Lỗi GET /cndl:', err.message);
    res.render('cndl', {
      indicators: [],
      assessments: [],
      year,
      city,
      error: 'Lỗi khi tải dữ liệu',
      success: '',
      user: req.user,
    });
  }
});

// Route POST /cndl (thay thế bằng mã mới)
app.post(
  '/cndl',
  authenticateToken,
  checkRole('admin'),
  [
    body('year').isInt({ min: 2000, max: 2100 }).withMessage('Năm phải từ 2000 đến 2100'),
    body('*.params.*')
      .optional()
      .trim()
      .customSanitizer(value => value.replace(',', '.').replace(/[^\d.]/g, ''))
      .matches(/^\d+(\.\d*)?$/)
      .withMessage('Tham số bổ sung phải là số dương')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Lỗi validation:', errors.array());
      return res.redirect(`/cndl?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    try {
      const year = req.body.year || new Date().getFullYear();
      const city = req.body.city || 'TP. Hồ Chí Minh';
      const assessor = req.user.username;
      const ip = req.ip;
      const userAgent = req.get('User-Agent');

      const indicatorCodes = [
        'ENI_RWE', 'SENIRE', 'EI_Save', 'EI_LR', 'SLI', 'GBpromo', 'VNGBI', 'R_CO2e',
        'R_S_water', 'Rcover', 'Rland_p', 'UBI_PNRA', 'GISapp', 'DISaster', 'ClimateAct',
        'NMT', 'PT_c', 'PT1000', 'STL', 'SRRW', 'RoadCap', 'AQstation', 'AQdata', 'CleanAirPlan', 'AQI_TDE',
        'WImanage', 'WI_loss', 'WI_rr', 'FloodRisk', 'Ewater', 'Ewwater', 'DigWater', 'R_USWA',
        'WasteInit', 'R_USWA_waste', 'RRWI', 'ConsWaste', 'WWT_I', 'DigWaste', 'LandfillEff', 'GHGIs'
      ];

      for (const indicator_code of indicatorCodes) {
        if (!req.body[indicator_code]) {
          console.warn(`Không tìm thấy dữ liệu cho chỉ số ${indicator_code}`);
          continue;
        }
        const data = req.body[indicator_code];
        const params = data.params || {};

        // Lấy indicator_id, domain_id từ bảng Indicators
        const indicatorRes = await pool.query(
          'SELECT indicator_id, domain_id, unit_code FROM Indicators WHERE code = $1',
          [indicator_code]
        );
        if (indicatorRes.rows.length === 0) {
          console.warn(`Không tìm thấy chỉ số ${indicator_code} trong bảng Indicators`);
          continue;
        }
        const { indicator_id, domain_id, unit_code } = indicatorRes.rows[0];

        // Tính giá trị chỉ số
        let result;
        try {
          result = await calculateIndicator(indicator_code, params);
        } catch (err) {
          console.error(`Lỗi khi tính chỉ số ${indicator_code}:`, err.message);
          continue;
        }

        // Lấy giá trị cũ để ghi lịch sử
        const oldQuery = await pool.query(
          'SELECT value, score_awarded, level, description FROM Assessments_Template WHERE city = $1 AND year = $2 AND indicator_code = $3',
          [city, year, indicator_code]
        );
        const oldValues = oldQuery.rows[0] || null;

        // Lưu vào Assessments_Template
        await pool.query(
          `INSERT INTO Assessments_Template (city, year, domain_id, indicator_id, indicator_code, value, unit_code, score_awarded, assessor, date, level, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10, $11)
           ON CONFLICT (city, year, indicator_code) DO UPDATE SET 
             value = EXCLUDED.value, 
             unit_code = EXCLUDED.unit_code,
             score_awarded = EXCLUDED.score_awarded, 
             assessor = EXCLUDED.assessor, 
             date = CURRENT_DATE, 
             level = EXCLUDED.level, 
             description = EXCLUDED.description`,
          [
            city,
            year,
            domain_id,
            indicator_id,
            indicator_code,
            result.value,
            unit_code,
            result.score,
            assessor,
            result.level,
            result.description
          ]
        );

        // Ghi lịch sử vào edit_history
        await pool.query(
          `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent, timestamp)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)`,
          [
            'Assessments_Template',
            `${city}_${year}_${indicator_code}`,
            oldValues ? JSON.stringify(oldValues) : null,
            JSON.stringify({
              value: result.value,
              score_awarded: result.score,
              level: result.level,
              description: result.description
            }),
            assessor,
            oldValues ? 'update' : 'insert',
            ip,
            userAgent
          ]
        );
      }

      res.redirect(`/dashboard?year=${year}&success=${encodeURIComponent('Dữ liệu đã được lưu thành công')}`);
    } catch (err) {
      console.error('Lỗi POST /cndl:', err.message);
      res.redirect(`/cndl?error=${encodeURIComponent(`Lỗi khi lưu dữ liệu: ${err.message}`)}`);
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
        `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
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
    res.render('lichsu', {
      user,
      history: historyRes.rows,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('Lỗi GET /lichsu:', err);
    res.render('lichsu', {
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
module.exports = app;

// Nếu chạy local thì dùng port 3000
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Local server running at http://localhost:${PORT}`);
  });
}