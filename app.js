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
const nodemailer = require('nodemailer');
const math = require('mathjs');
const { Pool } = require('pg');
const { uploadToNextDrive } = require('./drive-multi.js')
const router = express.Router();
const pdfMake = require('pdfmake');
const pdf = require('html-pdf');

console.log('🚀 Khởi động hệ thống Climate Smart City...');

// Express app
const app = express();
let currentOverallLevel = 3;
// Sửa: Thêm trust proxy cho Vercel
app.set('trust proxy', 1);

// 🚫 Không dùng Redis
console.warn("⚠️ Redis đã được tắt, hệ thống chỉ sử dụng PostgreSQL.");

// === CHỈ GIỮ LẠI 1 MULTER DUY NHẤT – DÙNG CHO TẤT CẢ ROUTE ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1000 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận: PDF, Word, Excel, ảnh (JPG/PNG/GIF)'), false);
    }
  }
});
//data
app.use('/data', express.static('data'));
// Công Thức Tính toán
const formulas = {
  'ENI_RWE': (p) => {
    const E_RE = parseFloat(p.E_RE) || 0;
    const EC = parseFloat(p.EC) || 1;
    const L_ATC = parseFloat(p.L_ATC || p['L_AT&C']) || 0; // Sử dụng L_ATC hoặc fallback về L_AT&C
    const P_RE = parseFloat(p.P_RE) || 0;
    const P_total = parseFloat(p.P_total) || 1;
    const reShare1 = (E_RE / EC) * 0.4 * 100;
    const reShare2 = (E_RE / (EC + L_ATC)) * 0.4 * 100;
    const capacityShare = (P_RE / P_total) * 0.2 * 100;
    const result = reShare1 + reShare2 + capacityShare;
    console.log(`ENI_RWE DEBUG: L_ATC=${L_ATC}, reShare2=${reShare2.toFixed(4)}, TOTAL=${result.toFixed(2)}`); // Debug
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
},
  'SENIRE': (p) => {
    const result = (parseFloat(p.SE_RE) || 0) / (parseFloat(p.ES) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'EI_Save': (p) => {
    const result = (parseFloat(p.E_Save) || 0) / (parseFloat(p.E_C) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'EI_LR': (p) => {
    const E_input = parseFloat(p.E_input) || 1;
    const E_delivered = parseFloat(p.E_delivered) || 0;
    const result = ((E_input - E_delivered) / E_input) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'SLI': (p) => {
    const SL_e = parseFloat(p.SL_e) || 0;
    const SL_s = parseFloat(p.SL_s) || 0;
    const SL = parseFloat(p.SL) || 1;
    const result = (0.8 * (SL_e / SL) + 0.2 * (SL_s / SL)) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'GBpromo': (p) => {
    const result = parseFloat(p.GBpromo) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'VNGBI': (p) => {
    const B_P = parseFloat(p.B_P) || 0;
    const B_AC = parseFloat(p.B_AC) || 1;
    const S_GB = parseFloat(p.S_GB) || 0;
    const S_BC = parseFloat(p.S_BC) || 1;
    const result = (0.2 * (B_P / B_AC) + 0.8 * (S_GB / S_BC)) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'R_CO2e': (p) => {
  // ===== 1. DỮ LIỆU ĐẦU VÀO =====
  const {
    co2eb_nam_DUL,   // tiêu thụ dầu (kg hoặc tấn theo thiết kế hệ thống)
    co2eb_nam_LPG,   // tiêu thụ LPG
    nam_BAU          // năm cần tính BAU (ví dụ: 2030)
  } = p;

  // ===== 2. HỆ SỐ CỐ ĐỊNH =====
  const TJ_DUL = 43;
  const TJ_LPG = 11.6;

  const EF_DUL = { CO2: 74100, CH4: 3.9, N2O: 3.9 };
  const EF_LPG = { CO2: 100000, CH4: 30, N2O: 4 };

  const GWP = { CO2: 1, CH4: 28, N2O: 265 };

  // ===== 3. HÀM TÍNH PHÁT THẢI CO2e =====
  const calcCO2e = (fuel, TJ, EF) => {
    const energyTJ = (fuel * TJ) / 1_000_000;
    const co2 = (energyTJ * EF.CO2) / 1000;
    const ch4 = (energyTJ * EF.CH4) / 1000;
    const n2o = (energyTJ * EF.N2O) / 1000;

    return (
      co2 * GWP.CO2 +
      ch4 * GWP.CH4 +
      n2o * GWP.N2O
    );
  };

  // ===== 4. PHÁT THẢI NĂM HIỆN TẠI =====
  const total_nam =
    calcCO2e(co2eb_nam_DUL, TJ_DUL, EF_DUL) +
    calcCO2e(co2eb_nam_LPG, TJ_LPG, EF_LPG);

  // ===== 5. BAU TUYẾN TÍNH (y = ax + b) =====
  // Năm gốc BAU (năm đầu chuỗi số liệu)
  const NAM_GOC = 2013;

  // Hệ số BAU (suy ra từ đồ thị)
  const a = 1.18 * 1_000_000; // tấn CO2e / năm
  const b = 9.5 * 1_000_000;  // phát thải tại năm 2013 (tấn CO2e)

  const total_BAU = a * (nam_BAU - NAM_GOC) + b;

  // ===== 6. TÍNH R_CO2e (%) =====
  if (total_BAU <= 0) return 0;

  const reduction =
    ((total_BAU - total_nam) / total_BAU) * 100;

  return Math.max(0, Math.min(100, reduction));
},
  'R_S-water': (p) => {
    const s_water_present = parseFloat(p.S_water_present) || 0;
    const s_water_plan = parseFloat(p.S_water_plan) || 0;
    const r_s_water = s_water_plan > 0 ? Math.min(100, Math.max(0, (s_water_present / s_water_plan) * 100)) : 0;

    const s_op_present = parseFloat(p.S_op_present) || 0;
    const s_op_plan = parseFloat(p.S_op_plan) || 0;
    const r_s_op = s_op_plan > 0 ? Math.min(100, Math.max(0, (s_op_present / s_op_plan) * 100)) : 0;

    const rso_total = (r_s_water + r_s_op) / 2;
    console.log(`R_S-water DEBUG: r_s_water=${r_s_water.toFixed(4)}%, r_s_op=${r_s_op.toFixed(4)}%, rso_total=${rso_total.toFixed(4)}%`); // Debug
    return isNaN(rso_total) || !isFinite(rso_total) ? 0 : Math.min(100, Math.max(0, rso_total));
},
  'Rcover': (p) => {
    const result = (parseFloat(p.S_pp) || 0) / (parseFloat(p.P) || 1);
    return Math.max(0, isNaN(result) || !isFinite(result) ? 0 : result);
  },
  'Rland_p': (p) => {
    const result = (parseFloat(p.S_land_p) || 0) / (parseFloat(p.S_total_land) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'UBI_PNRA': (p) => {
    const num = (parseFloat(p.A_natural) || 0) + (parseFloat(p.A_restored) || 0);
    const den = parseFloat(p.A_city) || 1;
    const result = (num / den) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'GISapp': (p) => {
    const result = parseFloat(p.GISapp) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'DISaster': (p) => {
    const result = parseFloat(p.DISaster) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'ClimateAct': (p) => {
    const result = parseFloat(p.ClimateAct) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'NMT': (p) => {
    const sumNMT_L = parseFloat(p.NMT_L) || 0;
    const sumL_R = parseFloat(p.L_R) || 1;
    const result = sumL_R > 0 ? (sumNMT_L * 100) / sumL_R : 0;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'PT_c': (p) => {
    const result = (parseFloat(p.PT_c) || 0) / (parseFloat(p.PT) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'PT1000': (p) => {
    const pt_f = parseFloat(p.PT_F) || 0;
    const population = parseFloat(p.P) || 1;
    if (population <= 0 || isNaN(population)) return 0;
    const result = (pt_f * 1000) / population;
    return isNaN(result) || !isFinite(result) ? 0 : result;
  },
  'STL': (p) => {
    const stl_s = parseFloat(p.STL_S) || 0;
    const tl = parseFloat(p.TL) || 1;
    const result = (stl_s / tl) * 100;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(100, result);
  },
  'SRRW': (p) => {
    const srrw_l = parseFloat(p.SRRW_L) || 0;
    const tsr = parseFloat(p.TSR) || 1;
    const result = ((srrw_l * 2) / tsr) * 100;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(100, result);
  },
  'RoadCap': (p) => {
    const result = parseFloat(p.RoadCap) || 0;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(5, Math.max(0, result));
  },
  'AQstation': (p) => {
    const result = parseFloat(p.AQstation) || 0;
    return isNaN(result) || !isFinite(result) ? 0 : Math.max(0, result);
  },
  'AQdata': (p) => {
    const result = parseFloat(p.AQdata) || 0;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(10, Math.max(0, result));
  },
  'CleanAirPlan': (p) => {
    const result = parseFloat(p.CleanAirPlan) || 0;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(5, Math.max(1, result));
  },
  "AQI_TDE": (p) => {
  const station1 = parseFloat(p.AQI_LyChinhThang) || 0;
  const station2 = parseFloat(p.AQI_DongNamBo) || 0;
  const totalDays = parseFloat(p.total_days) || 0;

  if (totalDays <= 0) return 0;

  const result = (station1 + station2) / totalDays;

  return isNaN(result) || !isFinite(result)
    ? 0
    : Math.min(1, Math.max(0, result));
},
  'WImanage': (p) => {
    const result = parseFloat(p.WImanage) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'WI_loss': (p) => {
    const prod = parseFloat(p.W_P) || 1;
    const result = ((prod - (parseFloat(p.W_S) || 0)) / prod) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'WI_rr': (p) => {
    const w_rr = parseFloat(p.W_rr) || 0;
    const w_s = parseFloat(p.W_s) || 1;
    const result = (w_rr / (0.8 * w_s)) * 100;
    return isNaN(result) || !isFinite(result) ? 0 : Math.min(100, Math.max(0, result));
  },
  'FloodRisk': (p) => {
    const result = parseFloat(p.FloodRisk) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'Ewater': (p) => {
    const value = parseFloat(p.Ewater) || 0;
    return isNaN(value) || !isFinite(value) || value < 0 ? 0 : value;
  },
  'Ewwater': (p) => {
    const value = parseFloat(p.Ewwater) || 0;
    return isNaN(value) || !isFinite(value) || value < 0 ? 0 : value;
  },
  'DigWater': (p) => {
    const value = parseFloat(p.DigWater) || 0;
    return isNaN(value) || !isFinite(value) || value < 0 ? 0 : value;
  },
  'R_USWA': (p) => {
    const ratio = parseFloat(p.ratio) || 0;
    return Math.max(0, Math.min(100, ratio));
},
  'WasteInit': (p) => {
    const result = parseFloat(p.Waste_Init) || 0;
    return Math.max(1, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'R_USWA_waste': (p) => {
    const result = (parseFloat(p.W_landfill) || 0) / (parseFloat(p.W_waste_generate) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'RRWI': (p) => {
    const num = (parseFloat(p.W_RU) || 0) + (parseFloat(p.W_RRC) || 0);
    const den = parseFloat(p.W_G) || 1;
    const result = (num / den) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'ConsWaste': (p) => {
  const w_cons_rr = parseFloat(p.W_Cons_rr) || 0;
  const w_cons_deli_reduce = parseFloat(p.W_Cons_deli_reduce) || 1;
  const result = (w_cons_rr / w_cons_deli_reduce) * 100;
  return isNaN(result) || !isFinite(result) ? 0 : Math.min(100, Math.max(0, result));
},
  'WWT_I': (p) => {
    const result = (parseFloat(p.W_T) || 0) / (parseFloat(p.W_G) || 1) * 100;
    return Math.max(0, Math.min(100, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'DigWaste': (p) => {
    const result = parseFloat(p.DigWaste) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'LandfillEff': (p) => {
    const result = parseFloat(p.LandfillEff) || 0;
    return Math.max(1, Math.min(5, isNaN(result) || !isFinite(result) ? 0 : result));
  },
  'GHGIs': (p) => {
    const result =
      (parseFloat(p.GHGs_Landfill) || 0) +
      (parseFloat(p.GHGs_WTE) || 0) +
      (parseFloat(p.GHGs_Recycling) || 0) +
      (parseFloat(p.GHGs_Composting) || 0);
    return isNaN(result) || !isFinite(result) ? 0 : result;
  }
};

// ==== View Engine ====
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==== Security Headers ====
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
        imgSrc: ["'self'", "data:", "https://*"],
        fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
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
const maxRequests = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 1000;

app.use(
  rateLimit({
    windowMs,
    max: maxRequests,
    keyGenerator: (req) => {
      // Lấy IP từ req.ip hoặc req.headers['x-forwarded-for']
      const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      // Loại bỏ prefix IPv6 nếu có
      return ip.replace(/^::ffff:/, '');
    },
    legacyHeaders: false,
    standardHeaders: true,
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

app.use((req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'unload=(self), pagehide=(self), visibilitychange=(self)'
  );
  next();
});

// ==== PostgreSQL (Neon) ====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool
  .query('SELECT NOW()')
  .then(() => console.log('✅ Connected to Neon PostgreSQL'))
  .catch((err) => {
    console.error('❌ PostgreSQL connection error:', { message: err.message, code: err.code });
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

// Sửa: Chỉ dùng PostgreSQL, không dùng Redis
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


// ==== Hàm phân tích khoảng (criteria) ====
function parseRange(criteria) {
  if (!criteria) return { min_value: null, max_value: null };
  const match = criteria.match(/([\d.]+)\s*[-–]\s*([\d.]+)/);
  if (match) {
    return { min_value: parseFloat(match[1]), max_value: parseFloat(match[2]) };
  }
  const gt = criteria.match(/>\s*([\d.]+)/);
  if (gt) return { min_value: parseFloat(gt[1]), max_value: null };
  const lt = criteria.match(/<\s*([\d.]+)/);
  if (lt) return { min_value: null, max_value: parseFloat(lt[1]) };
  return { min_value: null, max_value: null };
}

// ==== Danh sách tham số cho các chỉ số ====
const paramFields = {
  'ENI_RWE': [
    { key: 'E_RE', label: 'Năng lượng tái tạo sử dụng (kWh)' },
    { key: 'EC', label: 'Tổng năng lượng tiêu thụ (kWh)' },
    { key: 'L_AT&C', label: 'Tổn thất năng lượng (kWh)' },
    { key: 'P_RE', label: 'Công suất năng lượng tái tạo (kW)' },
    { key: 'P_total', label: 'Tổng công suất (kW)' }
  ],
  'SENIRE': [
    { key: 'SE_RE', label: 'Năng lượng tái tạo sử dụng trong khu vực công cộng (kWh)' },
    { key: 'ES', label: 'Tổng năng lượng tiêu thụ khu vực công cộng (kWh)' }
  ],
  'EI_Save': [
    { key: 'E_Save', label: 'Năng lượng tiết kiệm (kWh)' },
    { key: 'E_C', label: 'Tổng năng lượng tiêu thụ (kWh)' }
  ],
  'EI_LR': [
    { key: 'E_delivered', label: 'Năng lượng được truyền tải (kWh)' },
    { key: 'E_input', label: 'Năng lượng đầu vào (kWh)' }
  ],
  'SLI': [
    { key: 'SL_e', label: 'Đèn đường LED (số lượng)' },
    { key: 'SL_s', label: 'Đèn đường sử dụng năng lượng mặt trời (số lượng)' },
    { key: 'SL', label: 'Tổng số đèn đường (số lượng)' }
  ],
  'GBpromo': [
    { key: 'GBpromo', label: 'Số lượng dự án quảng bá tòa nhà xanh' }
  ],
  'VNGBI': [
    { key: 'B_P', label: 'Số lượng tòa nhà được chứng nhận xanh (P)' },
    { key: 'B_AC', label: 'Số lượng tòa nhà đạt chuẩn xanh (AC)' },
    { key: 'S_GB', label: 'Diện tích tòa nhà xanh (m²)' },
    { key: 'S_BC', label: 'Tổng diện tích tòa nhà (m²)' }
  ],
  'R_CO2e': [
    { key: 'CO2eb', label: 'Lượng phát thải CO2 cơ bản (tấn)' },
    { key: 'CO2et', label: 'Lượng phát thải CO2 hiện tại (tấn)' }
  ],
  'R_S-water': [
    { key: 'S_water_present', label: 'Diện tích mặt nước hiện tại (m²)' },
    { key: 'S_op_present', label: 'Diện tích không gian mở hiện tại (m²)' },
    { key: 'S_water_plan', label: 'Diện tích mặt nước theo kế hoạch (m²)' },
    { key: 'S_op_plan', label: 'Diện tích không gian mở theo kế hoạch (m²)' }
  ],
  'Rcover': [
    { key: 'S_pp', label: 'Diện tích đất được phục hồi (m²)' },
    { key: 'P', label: 'Tổng dân số' }
  ],
  'Rland_p': [
    { key: 'S_land_p', label: 'Diện tích đất được bảo vệ (m²)' },
    { key: 'S_total_land', label: 'Tổng diện tích đất (m²)' }
  ],
  'UBI_PNRA': [
    { key: 'A_natural', label: 'Diện tích tự nhiên (m²)' },
    { key: 'A_restored', label: 'Diện tích được phục hồi (m²)' },
    { key: 'A_city', label: 'Tổng diện tích thành phố (m²)' }
  ],
  'GISapp': [
    { key: 'GISapp', label: 'Số lượng ứng dụng GIS được triển khai' }
  ],
  'DISaster': [
    { key: 'DISaster', label: 'Số lượng kế hoạch ứng phó thảm họa' }
  ],
  'ClimateAct': [
    { key: 'ClimateAct', label: 'Số lượng hành động khí hậu' }
  ],
  'NMT': [
    { key: 'NMT_L', label: 'Chiều dài đường dành cho phương tiện không động cơ (km)' },
    { key: 'L_R', label: 'Tổng chiều dài đường (km)' }
  ],
  'PT_c': [
    { key: 'PT_c', label: 'Số lượng phương tiện giao thông công cộng (xe)' },
    { key: 'PT', label: 'Tổng số phương tiện giao thông (xe)' }
  ],
  'PT1000': [
    { key: 'PT_F', label: 'Số lượng chuyến giao thông công cộng (chuyến)' },
    { key: 'P', label: 'Tổng dân số' }
  ],
  'STL': [
    { key: 'STL_S', label: 'Diện tích đường có cây xanh (m²)' },
    { key: 'TL', label: 'Tổng chiều dài đường (km)' }
  ],
  'SRRW': [
    { key: 'SRRW_L', label: 'Chiều dài đường dành cho phương tiện không động cơ (km)' },
    { key: 'TSR', label: 'Tổng chiều dài đường (km)' }
  ],
  'RoadCap': [
    { key: 'RoadCap', label: 'Dung lượng đường (xe/km)' }
  ],
  'AQstation': [
    { key: 'AQstation', label: 'Số lượng trạm quan trắc chất lượng không khí' },
    { key: 'A_city', label: 'Tổng diện tích thành phố (m²)' }
  ],
  'AQdata': [
    { key: 'AQdata', label: 'Dữ liệu chất lượng không khí (số liệu)' }
  ],
  'CleanAirPlan': [
    { key: 'CleanAirPlan', label: 'Số lượng kế hoạch không khí sạch' }
  ],
  'AQI_TDE': [
    { key: 'AQI_exceed_days', label: 'Số ngày vượt ngưỡng AQI' }
  ],
  'WImanage': [
    { key: 'WImanage', label: 'Số lượng sáng kiến quản lý nước' }
  ],
  'WI_loss': [
    { key: 'W_P', label: 'Lượng nước sản xuất (m³)' },
    { key: 'W_S', label: 'Lượng nước cung cấp (m³)' }
  ],
  'WI_rr': [
    { key: 'W_rr', label: 'Lượng nước tái sử dụng (m³)' },
    { key: 'W_s', label: 'Tổng lượng nước cung cấp (m³)' }
  ],
  'FloodRisk': [
    { key: 'FloodRisk', label: 'Mức độ rủi ro lũ lụt (điểm)' }
  ],
  'Ewater': [
    { key: 'Ewater', label: 'Năng lượng sử dụng cho nước (kWh)' }
  ],
  'Ewwater': [
    { key: 'Ewwater', label: 'Năng lượng sử dụng cho xử lý nước thải (kWh)' }
  ],
  'DigWater': [
    { key: 'DigWater', label: 'Số lượng sáng kiến kỹ thuật số cho nước' }
  ],
  'R_USWA': [
    { key: 'P_W', label: 'Dân số sử dụng nước sạch' },
    { key: 'P_S', label: 'Tổng dân số' }
  ],
  'WasteInit': [
    { key: 'Waste_Init', label: 'Số lượng sáng kiến quản lý chất thải' }
  ],
  'R_USWA_waste': [
    { key: 'W_landfill', label: 'Lượng chất thải đưa vào bãi chôn lấp (tấn)' },
    { key: 'W_waste_generate', label: 'Tổng lượng chất thải tạo ra (tấn)' }
  ],
  'RRWI': [
    { key: 'W_RU', label: 'Lượng chất thải tái sử dụng (tấn)' },
    { key: 'W_RRC', label: 'Lượng chất thải tái chế (tấn)' },
    { key: 'W_G', label: 'Tổng lượng chất thải tạo ra (tấn)' }
  ],
  'ConsWaste': [
    { key: 'W_Cons_rr', label: 'Chất thải xây dựng tái chế (tấn)' },
    { key: 'W_Cons_deli_reduce', label: 'Chất thải xây dựng giảm thiểu (tấn)' }
  ],
  'WWT_I': [
    { key: 'W_T', label: 'Lượng nước thải được xử lý (m³)' },
    { key: 'W_G', label: 'Tổng lượng nước thải tạo ra (m³)' }
  ],
  'DigWaste': [
    { key: 'DigWaste', label: 'Số lượng sáng kiến kỹ thuật số cho chất thải' }
  ],
  'LandfillEff': [
    { key: 'LandfillEff', label: 'Hiệu quả bãi chôn lấp (điểm)' }
  ],
  'GHGIs': [
    { key: 'GHGs_Landfill', label: 'Khí thải nhà kính từ bãi chôn lấp (tấn CO2e)' },
    { key: 'GHGs_WTE', label: 'Khí thải nhà kính từ chuyển đổi chất thải thành năng lượng (tấn CO2e)' },
    { key: 'GHGs_Recycling', label: 'Khí thải nhà kính từ tái chế (tấn CO2e)' },
    { key: 'GHGs_Composting', label: 'Khí thải nhà kính từ ủ phân (tấn CO2e)' }
  ]
};
// Ánh xạ unit_code sang đơn vị hiển thị (thêm ngay sau object formulas trong app.js)
const unitDisplayMap = {
  'percent': '%',
  'm2_per_person': 'm²/người',
  'point_1_5': 'điểm (1-5)',
  'point_0_5': 'điểm (0-5)',
  'point_0_100': 'điểm (0-100)',
  'trips_per_1000': 'chuyến/1000 người',
  'stations_per_km2': 'trạm/km²',
  'kWh_per_m3': 'kWh/m³',
  'tCO2e_per_day': 'tCO₂e/ngày',
  'unknown': ''
};
// ==== FETCH UNITS FROM DB ====
async function getIndicatorUnits() {
  try {
    const result = await pool.query('SELECT code, unit FROM Indicators WHERE unit IS NOT NULL');
    const units = {};
    result.rows.forEach(row => {
      units[row.code] = row.unit;
    });
    console.log('✅ Loaded units from Neon:', Object.keys(units).length);
    return units;
  } catch (err) {
    console.error('❌ Error loading units:', err);
    return {};  // Fallback empty
  }
}

    // Cache units (gọi 1 lần khi start)
    let indicatorUnits = {};
    (async () => {
      indicatorUnits = await getIndicatorUnits();
    })();

    // Refresh nếu cần (ví dụ: sau insert mới)
    app.post('/refresh-units', authenticateToken, checkRole('admin'), async (req, res) => {
      indicatorUnits = await getIndicatorUnits();
      res.json({ success: 'Refreshed units' });
    });
// GET /api/file - Xem file từ assessment_files
app.get('/api/file', async (req, res) => {
  const { id, param } = req.query;
  if (!id || !param) {
    return res.status(400).send('Thiếu ID hoặc param');
  }

  try {
    const result = await pool.query(
      `SELECT file_data, file_name, file_type 
       FROM assessment_files 
       WHERE assessment_id = $1 AND param_name = $2`,
      [id, param]
    );

    if (result.rows.length === 0 || !result.rows[0].file_data) {
      return res.status(404).send('File không tồn tại');
    }

    const { file_data, file_name, file_type } = result.rows[0];
    res.setHeader('Content-Type', file_type);
    res.setHeader('Content-Disposition', `inline; filename="${file_name}"`);
    res.send(Buffer.from(file_data));
  } catch (err) {
    console.error('Lỗi GET /api/file:', err);
    res.status(500).send('Lỗi server');
  }
});
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

// Hàm parseRecipe để phân tích recipe_description
function parseRecipe(recipe) {
  if (!recipe) return [];
  try {
    return recipe.split(',').map(param => param.trim());
  } catch (err) {
    console.error('Lỗi parseRecipe:', err.message);
    return [];
  }
}

// Hàm evaluateFormula sử dụng mathjs
function evaluateFormula(formula, value, additionalParams = {}) {
  try {
    const numValue = parseFloat(value);
    if (isNaN(numValue)) {
      console.warn(`Giá trị không hợp lệ: ${value}`);
      return 0;
    }

    const qualitativeFormulas = [
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
      'Level of service'
    ];

    if (qualitativeFormulas.includes(formula)) {
      return numValue;
    }

    if (formula.includes('value *')) {
      const multiplier = parseFloat(formula.split('value *')[1].trim());
      if (isNaN(multiplier)) throw new Error('Hệ số nhân không hợp lệ');
      return numValue * multiplier;
    } else if (formula.includes('100 - value')) {
      return 100 - numValue;
    } else if (formula.includes('avg(')) {
      const params = formula.match(/avg\(([^)]+)\)/)[1].split(',').map(p => p.trim());
      const values = params.map(param => parseFloat(additionalParams[param] || numValue));
      if (values.some(v => isNaN(v))) throw new Error('Tham số không hợp lệ cho hàm avg');
      return values.reduce((sum, val) => sum + val, 0) / values.length;
    } else {
      let evalFormula = formula;
      for (const [key, val] of Object.entries(additionalParams)) {
        if (!/^\d+(\.\d*)?$/.test(val)) throw new Error(`Giá trị không hợp lệ cho tham số ${key}`);
        evalFormula = evalFormula.replace(new RegExp(`\\b${key}\\b`, 'g'), val);
      }
      evalFormula = evalFormula.replace('value', numValue.toString());
      const result = math.evaluate(evalFormula);
      if (typeof result !== 'number' || isNaN(result)) throw new Error('Kết quả công thức không hợp lệ');
      return result;
    }
  } catch (err) {
    console.error(`Lỗi xử lý công thức "${formula}": ${err.message}`);
    return parseFloat(value) || 0;
  }
}

// Hàm parseRange để phân tích tiêu chí min/max
function parseRange(criteria) {
  if (!criteria) return { min_value: null, max_value: null };
  const match = criteria.match(/\[(\d+),(\d+)\]/);
  if (match) {
    return {
      min_value: parseFloat(match[1]),
      max_value: parseFloat(match[2])
    };
  }
  return { min_value: null, max_value: null };
}
// ==================== TRANG CHỦ CHO GUEST (PHIÊN BẢN CHỈ XEM – CÓ TRỌNG SỐ) ====================
app.get('/', async (req, res) => {
  let client;
  try {
    const year = new Date().getFullYear(); // Hiện tại là 2025
    const city = 'TP. Hồ Chí Minh';

    client = await pool.connect();

    // 1. LẤY DOMAINS & INDICATORS
    const domainsRes = await client.query('SELECT * FROM Domains ORDER BY domain_id');
    const indicatorsRes = await client.query('SELECT * FROM Indicators ORDER BY domain_id, indicator_id');

    const domains = domainsRes.rows;
    const indicators = indicatorsRes.rows;

    // 2. LẤY ASSESSMENTS + TRỌNG SỐ CHỈ SỐ (an toàn với NULL)
    const assessmentsRes = await client.query(
      `
      SELECT
        a.domain_id,
        a.indicator_id,
        a.value,
        a.score_awarded,
        a.level,
        COALESCE(a.date::text, '') AS date_str,
        d.name AS domain_name,
        i.name AS indicator_name,
        COALESCE(iw.weight_within_domain, 0) AS weight_within_domain
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      LEFT JOIN indicatorweights iw
        ON a.indicator_id = iw.indicator_id AND a.domain_id = iw.domain_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.domain_id, a.indicator_id
      `,
      [city, year]
    );

    const assessments = assessmentsRes.rows;

    // 3. TRỌNG SỐ LĨNH VỰC
    const domainWeightsRes = await client.query('SELECT domain_id, weight FROM domainweights');
    const domainWeights = {};
    domainWeightsRes.rows.forEach(row => {
      domainWeights[row.domain_id] = Number(row.weight) || 0;
    });

    // 4. TÍNH ĐIỂM TỪNG LĨNH VỰC: Σ(wi × Zi) SAU KHI CHUẨN HÓA TRỌNG SỐ
    const domainScores = {};

    domains.forEach(domain => {
      // Lấy các chỉ số thuộc lĩnh vực
      const domainAssessments = assessments.filter(
        a => a.domain_id === domain.domain_id
      );

      // a. Lọc chỉ số có dữ liệu hợp lệ
      const validAssessments = domainAssessments.filter(a =>
        a.score_awarded !== null &&
        a.score_awarded !== undefined &&
        a.score_awarded !== '-' &&
        !isNaN(a.score_awarded)
      );

      // b. Nếu không có dữ liệu → điểm lĩnh vực = 0
      if (validAssessments.length === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      // c. Tính tổng trọng số hợp lệ
      const totalValidWeight = validAssessments.reduce(
        (sum, a) => sum + (Number(a.weight_within_domain) || 0),
        0
      );

      // d. Trường hợp trọng số = 0 → tránh chia cho 0
      if (totalValidWeight === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      // e. Tính điểm lĩnh vực với trọng số đã chuẩn hóa
      const domainScore = validAssessments.reduce((sum, a) => {
        const Zi = Number(a.score_awarded);
        const wi = Number(a.weight_within_domain) || 0;
        const normalizedWeight = wi / totalValidWeight;

        return sum + normalizedWeight * Zi;
      }, 0);

      // f. Làm tròn kết quả
      domainScores[domain.domain_id] = Number(domainScore.toFixed(3));
    });

    // 5. TÍNH ĐIỂM TỔNG HỢP
    const totalScore = Object.entries(domainScores).reduce((sum, [domainId, score]) => {
      const weight = domainWeights[domainId] || 0;
      return sum + (score * weight);
    }, 0);

    const finalTotalScore = Number(totalScore.toFixed(3));

    // 6. XẾP HẠNG TỔNG THỂ THEO ĐIỂM (0-100)
    let overallLevel = 1;
    let overallStars = '★';
    let overallDescription = 'Thành phố chưa tích hợp yếu tố khí hậu vào quản lý và quy hoạch; dữ liệu rời rạc, thiếu số hóa; chủ yếu phản ứng thụ động trước rủi ro khí hậu.';

    if (finalTotalScore >= 81) {
      overallLevel = 5;
      overallStars = '★★★★★';
      overallDescription = 'Thành phố phát thải thấp hoặc trung hòa carbon, hạ tầng thông minh, thích ứng với biến đổi khí hậu, có khả năng nhân rộng mô hình.';
    } else if (finalTotalScore >= 61) {
      overallLevel = 4;
      overallStars = '★★★★';
      overallDescription = 'Thành phố vận hành dựa trên dữ liệu số, quản trị thông minh, giảm phát thải rõ rệt, thích ứng khí hậu chủ động; liên kết tốt giữa quy hoạch, công nghệ và chính sách.';
    } else if (finalTotalScore >= 41) {
      overallLevel = 3;
      overallStars = '★★★';
      overallDescription = 'Các trụ cột của Thành phố thông minh với khí hậu đã được hình thành, với sự hiện diện của hệ thống dữ liệu, bộ chỉ số và các kế hoạch thích ứng, giảm phát thải.';
    } else if (finalTotalScore >= 21) {
      overallLevel = 2;
      overallStars = '★★';
      overallDescription = 'Đã có một số chính sách đơn lẻ, nhưng thiếu liên kết liên ngành; công nghệ thông minh và giải pháp khí hậu mới ở mức thí điểm.';
    }

    // 7. LẤY GEOJSON (nếu có)
    let geojson = null;
    try {
      const geoRes = await client.query('SELECT geojson_data FROM city_boundary WHERE city = $1', [city]);
      if (geoRes.rows.length > 0 && geoRes.rows[0].geojson_data) {
        geojson = JSON.parse(geoRes.rows[0].geojson_data);
      }
    } catch (e) {
      console.log('Không tải được GeoJSON:', e.message);
    }

    // 8. RENDER TRANG
    res.render('index', {
      totalScore: Math.round(finalTotalScore),
      overallLevel,
      overallStars,
      overallDescription,
      domainScores,
      domains,
      assessments,
      indicators,
      geojson,
      error: null,
      success: null
    });

  } catch (err) {
    console.error('Lỗi render trang chủ guest:', err.message, err.stack);
    res.status(500).render('error', {
      error: 'Lỗi hệ thống khi tải dữ liệu trang chủ. Vui lòng thử lại sau.',
      success: null
    });
  } finally {
    if (client) client.release();
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
app.get('/index', authenticateToken, (req, res) => {
  res.redirect('/dashboard');
});

// Tuyến đường POST /register
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

// Tuyến đường POST /login
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
        expiresIn: '24h',
      });
      res.cookie('token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
      res.redirect('/dashboard');
    } catch (err) {
      console.error('Lỗi POST /login:', err);
      res.redirect('/?error=Đăng nhập thất bại');
    }
  }
);

// Tuyến đường GET /dashboard
app.get('/dashboard', authenticateToken, async (req, res) => {
  let client;
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    client = await pool.connect();

    // 1. Lấy Domains & Indicators
    const domainsRes = await client.query('SELECT * FROM Domains ORDER BY domain_id');
    const indicatorsRes = await client.query('SELECT * FROM Indicators ORDER BY domain_id, indicator_id');

    const domains = domainsRes.rows || [];
    const indicators = indicatorsRes.rows || [];

    // 2. Lấy Assessments + trọng số chỉ số (an toàn với NULL)
    const assessmentsRes = await client.query(`
      SELECT 
        a.assessment_id,
        a.domain_id,
        a.indicator_id,
        a.value,
        a.score_awarded,
        a.level,
        COALESCE(a.date::text, '') AS date,
        d.name AS domain_name,
        i.name AS indicator_name,
        COALESCE(iw.weight_within_domain, 0) AS weight_within_domain
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      LEFT JOIN indicatorweights iw ON a.indicator_id = iw.indicator_id AND a.domain_id = iw.domain_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.domain_id, a.indicator_id
    `, [city, year]);

    const assessments = assessmentsRes.rows || [];

    // 3. Trọng số lĩnh vực
    const domainWeightsRes = await client.query('SELECT domain_id, weight FROM domainweights');
    const domainWeights = {};
    domainWeightsRes.rows.forEach(row => {
      domainWeights[row.domain_id] = Number(row.weight) || 0;
    });

    // 4. TÍNH ĐIỂM TỪNG LĨNH VỰC (LOẠI CHỈ SỐ THIẾU DỮ LIỆU & CHUẨN HÓA TRỌNG SỐ)
const domainScores = {};

domains.forEach(domain => {
  // Lấy các chỉ số thuộc lĩnh vực
  const domainAssessments = assessments.filter(
    a => a.domain_id === domain.domain_id
  );

  // a. Lọc chỉ số có dữ liệu hợp lệ
  const validAssessments = domainAssessments.filter(a =>
    a.score_awarded !== null &&
    a.score_awarded !== undefined &&
    a.score_awarded !== '-' &&
    !isNaN(a.score_awarded)
  );

  // b. Nếu không có chỉ số hợp lệ → điểm = 0
  if (validAssessments.length === 0) {
    domainScores[domain.domain_id] = 0;
    return;
  }

  // c. Tính tổng trọng số hợp lệ
  const totalValidWeight = validAssessments.reduce(
    (sum, a) => sum + (Number(a.weight_within_domain) || 0),
    0
  );

  // d. Tránh chia cho 0
  if (totalValidWeight === 0) {
    domainScores[domain.domain_id] = 0;
    return;
  }

  // e. Tính điểm lĩnh vực với trọng số đã chuẩn hóa
  const score = validAssessments.reduce((sum, a) => {
    const Zi = Number(a.score_awarded);
    const wi = Number(a.weight_within_domain) || 0;
    const normalizedWeight = wi / totalValidWeight;

    return sum + normalizedWeight * Zi;
  }, 0);

  // f. Làm tròn kết quả
  domainScores[domain.domain_id] = Number(score.toFixed(3));
});

    // 5. Tính tổng điểm
    const totalScoreRaw = Object.values(domainScores).reduce((sum, score) => {
      const domainId = Object.keys(domainScores).find(key => domainScores[key] === score);
      const weight = domainWeights[domainId] || 0;
      return sum + (score * weight);
    }, 0);
    const totalScore = Number(totalScoreRaw.toFixed(3));

    // 6. Xếp hạng tổng thể
    let overallLevel = 1;
    let overallDescription = 'Thành phố chưa tích hợp yếu tố khí hậu vào quản lý và quy hoạch; dữ liệu rời rạc, thiếu số hóa; chủ yếu phản ứng thụ động trước rủi ro khí hậu.';

    if (totalScore >= 81) { overallLevel = 5; overallDescription = 'Thành phố phát thải thấp hoặc trung hòa carbon, hạ tầng thông minh, thích ứng với biến đổi khí hậu, có khả năng nhân rộng mô hình.'; }
    else if (totalScore >= 61) { overallLevel = 4; overallDescription = 'Thành phố vận hành dựa trên dữ liệu số, quản trị thông minh, giảm phát thải rõ rệt, thích ứng khí hậu chủ động; liên kết tốt giữa quy hoạch, công nghệ và chính sách.'; }
    else if (totalScore >= 41) { overallLevel = 3; overallDescription = 'Các trụ cột của Thành phố thông minh với khí hậu đã được hình thành, với sự hiện diện của hệ thống dữ liệu, bộ chỉ số và các kế hoạch thích ứng, giảm phát thải.'; }
    else if (totalScore >= 21) { overallLevel = 2; overallDescription = 'Đã có một số chính sách đơn lẻ, nhưng thiếu liên kết liên ngành; công nghệ thông minh và giải pháp khí hậu mới ở mức thí điểm.'; }

    // 7. GeoJSON (an toàn)
    let geojson = null;
    try {
      const geoRes = await client.query('SELECT geojson_data FROM city_boundary WHERE city = $1', [city]);
      if (geoRes.rows[0]?.geojson_data) {
        geojson = JSON.parse(geoRes.rows[0].geojson_data);
      }
    } catch (geoErr) {
      console.log('GeoJSON lỗi (không nghiêm trọng):', geoErr.message);
    }

    // 8. Danh sách năm có dữ liệu
    const yearsRes = await client.query('SELECT DISTINCT year FROM Assessments_Template WHERE city = $1 ORDER BY year DESC', [city]);
    const years = yearsRes.rows.map(r => r.year);

    // 9. Render thành công
    res.render('dashboard', {
      user,
      currentPage: 'dashboard',  // Thêm dòng này
      domains,
      indicators,
      assessments,
      domainScores,
      totalScore: Math.round(totalScore),
      overallLevel,
      overallDescription,
      geojson,
      years,
      selectedYear: year,
      error: null,
      success: null
    });

  } catch (err) {
    console.error('LỖI DASHBOARD:', err.message);
    console.error(err.stack);

    // Render trang với dữ liệu tối thiểu, không crash
    res.render('dashboard', {
      user: req.user || null,
      domains: [],
      indicators: [],
      assessments: [],
      domainScores: {1:0,2:0,3:0,4:0,5:0},
      totalScore: 0,
      overallLevel: 1,
      overallDescription: 'Không có dữ liệu để hiển thị.',
      geojson: null,
      years: [],
      selectedYear: null,
      error: 'Không thể tải dữ liệu. Có thể chưa có dữ liệu cho năm ' + (req.query.year || new Date().getFullYear()) + '. Vui lòng cập nhật dữ liệu trước.',
      success: null
    });
  } finally {
    if (client) client.release();
  }
});
app.post('/api/update-indicator-source', async (req, res) => {
  const updates = req.body;
  if (!Array.isArray(updates) || !updates.length)
    return res.json({ success: true });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sql = `
      INSERT INTO indicator_sources
      (indicator_code, param_code, source_text, year, city)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (indicator_code, param_code, year, city)
      DO UPDATE SET source_text = EXCLUDED.source_text, updated_at = NOW();
    `;

    for (const u of updates) {
      await client.query(sql, [
        u.indicator,
        u.param,
        u.source_text,
        u.year,
        u.city
      ]);
    }

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: e.message });
  } finally {
    client.release();
  }
});
// GET /api/get-indicator-source
app.get('/api/get-indicator-source', async (req, res) => {
  const { indicator, param, year, city } = req.query;

  const result = await pool.query(
    `
    SELECT source_text
    FROM indicator_sources
    WHERE indicator_code = $1
      AND param_code = $2
      AND year = $3
      AND city = $4
    LIMIT 1
    `,
    [indicator, param, year, city]
  );

  res.json({
    source_text: result.rows[0]?.source_text || ''
  });
});

// POST /cndl – PHIÊN BẢN ĐÃ SỬA LỖI indicatorCodes is not defined
app.post(
  '/cndl',
  authenticateToken,
  upload.any(),
  [
    body('year').isInt({ min: 2000, max: 2100 }).withMessage('Năm phải từ 2000 đến 2100'),
    body('domain_id').isInt().withMessage('Thiếu lĩnh vực đánh giá'),
    body().custom((_, { req }) => {
      for (const key in req.body) {
        if (!key.endsWith('[params][value]')) continue;
        const value = req.body[key];
        if (value === '' || value === null || value === undefined) continue;

        const cleaned = String(value)
          .replace(/\./g, '')
          .replace(/,/g, '.');

        const num = parseFloat(cleaned);
        if (isNaN(num) || !isFinite(num)) {
          throw new Error('Giá trị định lượng phải là số hợp lệ');
        }
      }
      return true;
    })
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.redirect(`/cndl?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const year = parseInt(req.body.year) || new Date().getFullYear();
      const city = req.body.city || 'TP. Hồ Chí Minh';
      const assessor = req.user.username;
      const ip = req.ip;
      const userAgent = req.get('User-Agent');

      // KHỞI TẠO DANH SÁCH TẤT CẢ CHỈ SỐ – BẮT BUỘC PHẢI CÓ Ở ĐÂY
      const indicatorCodes = [
        'ENI_RWE', 'SENIRE', 'EI_Save', 'EI_LR', 'SLI', 'GBpromo', 'VNGBI', 'R_CO2e',
        'R_S-water', 'Rcover', 'Rland_p', 'UBI_PNRA', 'GISapp', 'DISaster', 'ClimateAct',
        'NMT', 'PT_c', 'PT1000', 'STL', 'SRRW', 'RoadCap', 'AQstation', 'AQdata', 'CleanAirPlan', 'AQI_TDE',
        'WImanage', 'WI_loss', 'WI_rr', 'FloodRisk', 'Ewater', 'Ewwater', 'DigWater', 'R_USWA',
        'WasteInit', 'R_USWA_waste', 'RRWI', 'ConsWaste', 'WWT_I', 'DigWaste', 'LandfillEff', 'GHGIs'
      ];

      // === HÀM CHUẨN HÓA SỐ ===
      const toNumber = (value) => {
        if (value === '' || value == null || value === undefined) return null;
        const cleaned = String(value).trim().replace(/\./g, '').replace(/,/g, '.');
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
      };

      const uploadedFiles = [];

      // === XỬ LÝ DỮ LIỆU NESTED ===
      const params = {};
      for (const key of Object.keys(req.body)) {
        const match = key.match(/^(.+?)\[params\]\[(.+?)\]$/);
        if (match) {
          const [_, indicator, param] = match;
          if (!params[indicator]) params[indicator] = { params: {}, reference: {} };
          params[indicator].params[param] = req.body[key];
        } else if (indicatorCodes.includes(key)) {
          try {
            const parsed = typeof req.body[key] === 'string' ? JSON.parse(req.body[key]) : req.body[key];
            if (!params[key]) params[key] = { params: {}, reference: {} };
            Object.assign(params[key].params, parsed.params || {});
          } catch (e) { /* bỏ qua */ }
        }
      }

      // === CHỈ XỬ LÝ NHỮNG CHỈ SỐ ĐƯỢC GỬI LÊN (TỨC LÀ ĐƯỢC TICK TRONG LĨNH VỰC ĐƯỢC NHẤN LƯU) ===
      for (const indicator_code of Object.keys(params)) {
        const indicatorData = params[indicator_code];
        const rawParams = indicatorData.params || {};

        // Chuẩn hóa params
        const paramsNum = Object.fromEntries(
          Object.entries(rawParams).map(([k, v]) => [k, toNumber(v)])
        );

        // Nếu không có dữ liệu hợp lệ (tick nhưng rỗng hết) → skip, giữ nguyên cũ
        const hasValidData = Object.values(paramsNum).some(v => v !== null);
        if (!hasValidData) continue;

        const indicatorRes = await client.query(
          'SELECT indicator_id, domain_id, unit_code FROM Indicators WHERE code = $1',
          [indicator_code]
        );
        if (indicatorRes.rows.length === 0) continue;

        const { indicator_id, domain_id, unit_code } = indicatorRes.rows[0];

        let finalValue = null;
        let levelToSave = null;
        let scoreToSave = null;
        let descriptionToSave = 'Chưa có dữ liệu';

        let calculated = null;
        if (formulas[indicator_code]) {
          try {
            calculated = formulas[indicator_code](paramsNum);
            if (isNaN(calculated) || !isFinite(calculated)) calculated = null;
          } catch (err) {
            console.error(`Lỗi công thức ${indicator_code}:`, err.message);
            calculated = null;
          }
        }

        finalValue = calculated !== null ? parseFloat(calculated.toFixed(2)) : null;

        if (unit_code === 'percent' && finalValue !== null) {
          finalValue = Math.max(0, Math.min(100, finalValue));
        }

        if (finalValue !== null) {
          const levelsRes = await client.query(
            `SELECT level, score_value, description, min_value, max_value 
             FROM ScoringLevels WHERE indicator_id = $1 ORDER BY level ASC`,
            [indicator_id]
          );

          let matched = false;
          for (const row of levelsRes.rows) {
            const min = row.min_value;
            const max = row.max_value;
            if ((min === null || finalValue >= min) && (max === null || finalValue < max)) {
              levelToSave = row.level;
              scoreToSave = row.score_value ?? null;
              descriptionToSave = row.description || '';
              matched = true;
              break;
            }
          }
          if (!matched) {
            descriptionToSave = 'Giá trị ngoài thang đánh giá';
          }
        }

        const valueStr = finalValue !== null ? finalValue.toFixed(6) : null;
        const paramsJson = JSON.stringify(paramsNum);

        // Lấy giá trị cũ để ghi lịch sử
        const oldRes = await client.query(
          'SELECT value, score_awarded, level, description, params FROM Assessments_Template WHERE city = $1 AND year = $2 AND indicator_code = $3',
          [city, year, indicator_code]
        );
        const oldValues = oldRes.rows[0] || null;

        // === UPSERT ===
        const upsertRes = await client.query(
          `INSERT INTO Assessments_Template 
           (city, year, domain_id, indicator_id, indicator_code, value, unit_code, score_awarded, assessor, date, level, description, params)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, $10, $11, $12)
           ON CONFLICT (city, year, indicator_code) DO UPDATE SET
             value = EXCLUDED.value,
             unit_code = EXCLUDED.unit_code,
             score_awarded = EXCLUDED.score_awarded,
             assessor = EXCLUDED.assessor,
             date = CURRENT_DATE,
             level = EXCLUDED.level,
             description = EXCLUDED.description,
             params = EXCLUDED.params
           RETURNING assessment_id`,
          [
            city, year, domain_id, indicator_id, indicator_code,
            valueStr, unit_code, scoreToSave, assessor,
            levelToSave, descriptionToSave, paramsJson
          ]
        );

        const assessmentId = upsertRes.rows[0].assessment_id;

        // === XỬ LÝ FILE ===
        const files = req.files?.filter(f => 
          f.fieldname.startsWith(`${indicator_code}[reference]`) && 
          f.fieldname.endsWith('[]')
        ) || [];

        for (const file of files) {
          const match = file.fieldname.match(/\[reference\]\[(.+?)\]\[\]$/);
          if (!match) continue;
          const paramName = match[1];

          const safeFileName = `${year}_${city.replace(/[^a-zA-Z0-9]/g, '_')}_${indicator_code}_${paramName}_${file.originalname}`;

          let driveLink = null;
          try {
            driveLink = await uploadToNextDrive(file.buffer, safeFileName, file.mimetype);
            await client.query(
              `INSERT INTO assessment_files
               (assessment_id, param_name, file_name, file_type, drive_link, uploaded_at)
               VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
               ON CONFLICT (assessment_id, param_name, file_name) DO UPDATE SET
                 drive_link = EXCLUDED.drive_link,
                 file_type = EXCLUDED.file_type,
                 uploaded_at = CURRENT_TIMESTAMP`,
              [assessmentId, paramName, file.originalname, file.mimetype, driveLink]
            );
            await client.query(
              `UPDATE assessment_files SET file_data = NULL
               WHERE assessment_id = $1 AND param_name = $2 AND file_name = $3`,
              [assessmentId, paramName, file.originalname]
            );

            console.log(`[UPLOAD SUCCESS] ${indicator_code} | ${paramName} | ${file.originalname} → ${driveLink}`);
            uploadedFiles.push({
              indicator: indicator_code,
              param: paramName,
              name: file.originalname,
              link: driveLink
            });
          } catch (driveErr) {
            console.error(`[UPLOAD FAILED] ${file.originalname}:`, driveErr.message);
            await client.query(
              `INSERT INTO assessment_files (assessment_id, param_name, file_data, file_name, file_type)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (assessment_id, param_name, file_name) DO UPDATE SET
                 file_data = EXCLUDED.file_data, file_type = EXCLUDED.file_type`,
              [assessmentId, paramName, file.buffer, file.originalname, file.mimetype]
            );
          }
        }

        await client.query(`UPDATE Assessments_Template SET reference_file = NULL WHERE assessment_id = $1`, [assessmentId]);

        // Ghi lịch sử thay đổi
        await client.query(
          `INSERT INTO edit_history 
           (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            'Assessments_Template',
            `${city}_${year}_${indicator_code}`,
            oldValues ? JSON.stringify(oldValues) : null,
            JSON.stringify({
              value: valueStr,
              score_awarded: scoreToSave,
              level: levelToSave,
              description: descriptionToSave,
              params: paramsJson
            }),
            assessor,
            oldValues ? 'update' : 'insert',
            ip,
            userAgent
          ]
        );
      }

      await client.query('COMMIT');

      const successMsg = uploadedFiles.length > 0
        ? `Lưu thành công! Đã upload ${uploadedFiles.length} file.`
        : 'Lưu thành công!';

      res.redirect(`/dashboard?year=${year}&success=${encodeURIComponent(successMsg)}&files=${encodeURIComponent(JSON.stringify(uploadedFiles))}`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Lỗi POST /cndl:', err);
      res.redirect(`/cndl?error=${encodeURIComponent('Lỗi hệ thống: ' + err.message)}`);
    } finally {
      client.release();
    }
  }
);
// GET /cndl - Trang nhập liệu (giữ nguyên hoàn toàn)
app.get('/cndl', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    const [domainsRes, indicatorsRes, assessmentsRes] = await Promise.all([
      pool.query('SELECT * FROM Domains ORDER BY domain_id'),
      pool.query(`SELECT i.*, COALESCE(i.recipe_description, '') AS recipe_description FROM Indicators i ORDER BY domain_id, indicator_id`),
      pool.query('SELECT indicator_code, value FROM Assessments_Template WHERE city = $1 AND year = $2', [city, year])
    ]);

    const domains = domainsRes.rows.map(d => ({
      ...d,
      icon: d.icon || { 1: 'fas fa-bolt', 2: 'fas fa-leaf', 3: 'fas fa-car', 4: 'fas fa-tint', 5: 'fas fa-trash' }[d.domain_id] || 'fas fa-cog'
    }));

    const indicators = indicatorsRes.rows.map(ind => ({
      ...ind,
      variables: parseRecipe(ind.recipe_description),
      existing_value: assessmentsRes.rows.find(a => a.indicator_code === ind.code)?.value || null
    }));

    res.render('cndl/cndl-index', {
      user: req.user,
      currentPage: 'cndl',  // Thêm dòng này
      city, year, domains, indicators,
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('Lỗi GET /cndl:', err);
    res.render('cndl/cndl-index', { user: req.user, city: 'TP. Hồ Chí Minh', domains: [], indicators: [], year: new Date().getFullYear(), error: 'Lỗi tải dữ liệu', success: null });
  }
});

// Route POST /cndl/preview – ĐÃ SỬA (KHÔNG CÓ FORMULAS TRÙNG)
app.post('/cndl/preview', authenticateToken, async (req, res) => {
  try {
    const { indicatorCode, params } = req.body;

    console.log('[PREVIEW] Request:', { indicatorCode, params });
    console.log('[PREVIEW] Available formulas:', Object.keys(formulas).sort());

    if (!indicatorCode || typeof indicatorCode !== 'string') {
      return res.status(400).json({ success: false, message: 'Mã chỉ số bị thiếu' });
    }

    const formulaFn = formulas[indicatorCode];
    if (typeof formulaFn !== 'function') {
      console.error(`[ERROR] Không tìm thấy công thức cho: ${indicatorCode}`);
      return res.status(400).json({
        success: false,
        message: 'Chỉ số không hợp lệ',
        available: Object.keys(formulas).sort()
      });
    }

    if (!params || typeof params !== 'object' || Object.keys(params).length === 0) {
      return res.status(400).json({ success: false, message: 'Tham số không hợp lệ' });
    }

    let rawResult;
    try {
      if (formulaFn.constructor.name === 'AsyncFunction') {
        rawResult = await formulaFn(params);
      } else {
        rawResult = formulaFn(params);
      }
    } catch (err) {
      return res.status(400).json({ success: false, message: `Lỗi tính toán: ${err.message}` });
    }

    let value;
    if (typeof rawResult === 'object' && rawResult !== null && 'value' in rawResult) {
      value = parseFloat(rawResult.value);
    } else if (typeof rawResult === 'number') {
      value = rawResult;
    } else {
      return res.status(400).json({ success: false, message: 'Kết quả không hợp lệ' });
    }

    if (isNaN(value) || !isFinite(value)) {
      return res.status(400).json({ success: false, message: 'Kết quả không hợp lệ (NaN)' });
    }

    let unit_code = 'unknown';
    let displayUnit = '';
    try {
      const indRes = await pool.query('SELECT unit_code FROM Indicators WHERE code = $1', [indicatorCode]);
      if (indRes.rows.length > 0) unit_code = indRes.rows[0].unit_code || 'unknown';
      displayUnit = unitDisplayMap[unit_code] || '';
    } catch (e) { /* ignore */ }

    let finalValue = parseFloat(value.toFixed(2));
    if (unit_code === 'percent') {
      finalValue = Math.max(0, Math.min(100, finalValue));
    }

    let levelInfo = { level: 'N/A', score_value: 0, description: '' };
    try {
      const levels = await pool.query(
        `SELECT level, score_value, description, min_value, max_value 
         FROM scoringlevels WHERE indicator_code = $1 ORDER BY level ASC`,
        [indicatorCode]
      );
      for (const row of levels.rows) {
        const min = row.min_value;
        const max = row.max_value;
        if ((min === null || finalValue >= min) && (max === null || finalValue < max)) {
          levelInfo = {
            level: row.level,
            score_value: row.score_value || 0,
            description: row.description || ''
          };
          break;
        }
      }
    } catch (e) { /* ignore */ }

    res.json({
      success: true,
      value: finalValue,
      unit: displayUnit,
      level: levelInfo.level,
      score: levelInfo.score_value,
      description: levelInfo.description
    });

  } catch (err) {
    console.error('Lỗi /cndl/preview:', err);
    res.status(500).json({ success: false, message: 'Lỗi máy chủ' });
  }
});

// GET /edit_cndl/:id - Chỉnh sửa 1 bản ghi
app.get('/edit_cndl/:id', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const assessmentId = req.params.id;
    const result = await pool.query(
      `SELECT a.*, i.name AS indicator_name, i.code AS indicator_code, i.unit_code, i.domain_id
       FROM Assessments_Template a
       JOIN Indicators i ON a.indicator_id = i.indicator_id
       WHERE a.assessment_id = $1`,
      [assessmentId]
    );

    if (!result.rows[0]) {
      return res.redirect(`/qldl?error=${encodeURIComponent('Không tìm thấy dữ liệu')}`);
    }

    const item = result.rows[0];
    const filesRes = await pool.query(
      'SELECT param_name AS param, file_name, file_type FROM assessment_files WHERE assessment_id = $1',
      [assessmentId]
    );
    item.files = filesRes.rows;

    res.render('edit_cndl', {
      user: req.user,
      currentPage: 'edit_cndl',  // Thêm dòng này
      table: 'Assessments_Template',
      item,
      fields: ['city', 'year', 'indicator_code', 'value', 'unit_code', 'score_awarded', 'assessor', 'level', 'description'],
      paramFields: paramFields[item.indicator_code] || [],
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('Lỗi GET /edit_cndl:', err);
    res.redirect(`/qldl?error=${encodeURIComponent('Lỗi tải dữ liệu')}`);
  }
});

// POST /edit_cndl/:id - Cập nhật 1 bản ghi
app.post(
  '/edit_cndl/:id',
  authenticateToken,
  checkRole('admin'),
  upload.any(),
  [
    body('value')
      .optional()
      .trim()
      .customSanitizer(v => String(v).replace(/,/g, '.').replace(/[^\d.-]/g, ''))
      .custom(v => v === '' || (!isNaN(parseFloat(v)) && isFinite(parseFloat(v))))
      .withMessage('Giá trị phải là số hợp lệ'),
    body('params.*')
      .optional()
      .trim()
      .customSanitizer(v => String(v).replace(/,/g, '.').replace(/[^\d.-]/g, ''))
      .custom(v => v === '' || (!isNaN(parseFloat(v)) && isFinite(parseFloat(v))))
      .withMessage('Tham số phải là số hợp lệ')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.redirect(`/edit_cndl/${req.params.id}?error=${encodeURIComponent(errors.array()[0].msg)}`);
    }

    try {
      const assessmentId = req.params.id;
      const { value, params: rawParams } = req.body;
      const assessor = req.user.username;
      const ip = req.ip;
      const userAgent = req.get('User-Agent');

      const assessmentRes = await pool.query(
        `SELECT a.*, i.code AS indicator_code, i.indicator_id, i.domain_id, i.unit_code
         FROM Assessments_Template a
         JOIN Indicators i ON a.indicator_id = i.indicator_id
         WHERE a.assessment_id = $1`,
        [assessmentId]
      );

      if (!assessmentRes.rows[0]) {
        return res.redirect(`/qldl?error=${encodeURIComponent('Không tìm thấy dữ liệu')}`);
      }

      const { indicator_id, domain_id, unit_code, indicator_code, city, year } = assessmentRes.rows[0];

      const params = rawParams ? Object.fromEntries(
        Object.entries(rawParams).map(([k, v]) => [k, parseFloat(v) || 0])
      ) : {};

      let newValue = value ? parseFloat(value) : null;
      if ((!newValue || newValue === 0) && Object.keys(params).length > 0 && formulas[indicator_code]) {
        try {
          newValue = formulas[indicator_code](params);
        } catch (err) {
          console.error(`Lỗi công thức ${indicator_code}:`, err);
          newValue = 0;
        }
      }
      newValue = isFinite(newValue) ? newValue : 0;
      if (unit_code === 'percent') newValue = Math.max(0, Math.min(100, newValue));

      const levelsRes = await pool.query(
        'SELECT level, score_value, description, evaluation_criteria FROM ScoringLevels WHERE indicator_id = $1 ORDER BY level',
        [indicator_id]
      );

      let selectedLevel = { level: 1, score_value: 0, description: 'Không xác định' };
      for (const lvl of levelsRes.rows) {
        const { min_value, max_value } = parseRange(lvl.evaluation_criteria);
        if ((min_value == null || newValue >= min_value) && (max_value == null || newValue <= max_value)) {
          selectedLevel = { level: lvl.level, score_value: lvl.score_value, description: lvl.description };
          break;
        }
      }

      const oldRes = await pool.query('SELECT value, score_awarded, level, description, params FROM Assessments_Template WHERE assessment_id = $1', [assessmentId]);
      const oldValues = oldRes.rows[0];

      const valueStr = newValue.toFixed(6);
      await pool.query(
        `UPDATE Assessments_Template SET
           value = $1, score_awarded = $2, assessor = $3, date = CURRENT_DATE,
           level = $4, description = $5, params = $6, reference_file = NULL
         WHERE assessment_id = $7`,
        [valueStr, selectedLevel.score_value, assessor, selectedLevel.level, selectedLevel.description, JSON.stringify(params), assessmentId]
      );

      // Xử lý file
      const files = req.files?.filter(f => f.fieldname.startsWith(`${indicator_code}[reference]`)) || [];
      for (const file of files) {
        const match = file.fieldname.match(/\[reference\]\[(.+?)\]$/);
        if (!match || file.size > 5 * 1024 * 1024) continue;
        const paramName = match[1];
        await pool.query(
          `INSERT INTO assessment_files (assessment_id, param_name, file_data, file_name, file_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (assessment_id, param_name) DO UPDATE SET
             file_data = EXCLUDED.file_data, file_name = EXCLUDED.file_name, file_type = EXCLUDED.file_type, uploaded_at = CURRENT_TIMESTAMP`,
          [assessmentId, paramName, file.buffer, file.originalname, file.mimetype]
        );
      }

      // Ghi lịch sử
      await pool.query(
        `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'Assessments_Template', assessmentId,
          JSON.stringify(oldValues),
          JSON.stringify({ value: valueStr, score_awarded: selectedLevel.score_value, level: selectedLevel.level, description: selectedLevel.description, params }),
          assessor, 'update', ip, userAgent
        ]
      );

      res.redirect(`/qldl?success=${encodeURIComponent('Cập nhật thành công')}`);
    } catch (err) {
      console.error('Lỗi POST /edit_cndl:', err);
      res.redirect(`/edit_cndl/${req.params.id}?error=${encodeURIComponent('Lỗi cập nhật')}`);
    }
  }
);

// DÙNG RAM THAY REDIS – NHANH, NHẸ, KHÔNG LỖI
const cache = new Map();

async function getCachedOrQuery(cacheKey, query, params = []) {
  try {
    // Kiểm tra cache trong RAM
    if (cache.has(cacheKey)) {
      console.log(`CACHE HIT: ${cacheKey}`);
      return cache.get(cacheKey);
    }

    // Nếu không có → query DB
    const result = await pool.query(query, params);
    const data = result.rows;

    // Lưu vào cache 1 giờ
    cache.set(cacheKey, data);
    setTimeout(() => cache.delete(cacheKey), 3600 * 1000);

    console.log(`CACHE MISS → DB: ${cacheKey}`);
    return data;
  } catch (err) {
    console.error('Lỗi cache hoặc query:', err.message);
    // Nếu lỗi → vẫn cố query DB
    try {
      const result = await pool.query(query, params);
      return result.rows;
    } catch (dbErr) {
      console.error('Lỗi DB:', dbErr.message);
      return [];
    }
  }
}
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

// Tuyến đường POST /forgot-password
app.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
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

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.redirect('/forgot-password?error=Token không hợp lệ hoặc đã hết hạn');
    }

    const { email } = decoded;
    const result = await pool.query('SELECT * FROM Users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.redirect('/forgot-password?error=Email không tồn tại');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('UPDATE Users SET password = $1 WHERE email = $2', [hashedPassword, email]);

    res.redirect('/login?success=Mật khẩu đã được đặt lại thành công');
  } catch (err) {
    console.error('❌ Lỗi xử lý đặt lại mật khẩu:', err.message);
    res.redirect(`/reset-password?token=${req.body.token || ''}&error=Có lỗi xảy ra, vui lòng thử lại`);
  }
});

// ==================== GET /qldl ====================
app.get('/qldl', authenticateToken, checkRole('admin'), async (req, res) => {
  let client;
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Lấy assessments
    const assessmentsRes = await client.query(
      `
      SELECT 
        a.*, 
        d.name AS domain_name, 
        i.name AS indicator_name,
        COALESCE(a.date::text, '') AS date_str
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.year DESC, a.domain_id, a.indicator_id
      `,
      [city, year]
    );

    // 2. Lấy danh sách năm
    const yearsRes = await client.query(
      'SELECT DISTINCT year FROM Assessments_Template WHERE city = $1 ORDER BY year DESC',
      [city]
    );
    const years = yearsRes.rows.map(r => r.year);

    // 3. Lấy file (1 query)
    const ids = assessmentsRes.rows.map(r => r.assessment_id);
    const fileMap = {};
    if (ids.length > 0) {
      const fileRes = await client.query(
        `SELECT assessment_id, param_name AS param, file_name 
         FROM assessment_files 
         WHERE assessment_id = ANY($1::int[])`,
        [ids]
      );
      fileRes.rows.forEach(f => {
        if (!fileMap[f.assessment_id]) fileMap[f.assessment_id] = [];
        fileMap[f.assessment_id].push({ param: f.param, file_name: f.file_name });
      });
    }

    // 4. Gắn file + chuẩn hóa date
    const assessments = assessmentsRes.rows.map(row => {
      const date = row.date_str ? new Date(row.date_str) : null;
      return {
        ...row,
        files: fileMap[row.assessment_id] || [],
        date_obj: date,
        date_iso: date ? date.toISOString().split('T')[0] : '',
        month: date ? date.getMonth() + 1 : '',
        year_display: date ? date.getFullYear() : ''
      };
    });

    await client.query('COMMIT');

    res.render('qldl', {
      user,
      currentPage: 'qldl',  // Thêm dòng này
      assessments,
      years,
      selectedYear: year,
      error: req.query.error || null,
      success: req.query.success || null,
    });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Lỗi GET /qldl:', err.message, err.stack);
    res.render('qldl', {
      user: req.user || { username: 'Unknown', role: 'admin' },
      assessments: [],
      years: [],
      selectedYear: null,
      error: 'Lỗi hệ thống: ' + err.message,
      success: null,
    });
  } finally {
    if (client) client.release();
  }
});

// ==================== POST /qldl/delete/:id ====================
app.post('/qldl/delete/:id', authenticateToken, checkRole('admin'), async (req, res) => {
  let client;
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.redirect('/qldl?error=ID không hợp lệ');

    client = await pool.connect();
    await client.query('BEGIN');

    const oldRes = await client.query(
      `SELECT a.*, i.code FROM Assessments_Template a
       JOIN Indicators i ON a.indicator_id = i.indicator_id
       WHERE a.assessment_id = $1`, [id]
    );

    if (oldRes.rows.length === 0) {
      await client.query('COMMIT');
      return res.redirect('/qldl?error=Không tìm thấy');
    }

    const old = oldRes.rows[0];
    await client.query(
      `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ['Assessments_Template', id, JSON.stringify(old), '{}', req.user.username, 'delete', req.ip, req.get('User-Agent')]
    );

    await client.query('DELETE FROM assessment_files WHERE assessment_id = $1', [id]);
    await client.query('DELETE FROM Assessments_Template WHERE assessment_id = $1', [id]);

    await client.query('COMMIT');
    res.redirect('/qldl?success=Xóa thành công');
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Lỗi DELETE:', err);
    res.redirect('/qldl?error=Lỗi xóa');
  } finally {
    if (client) client.release();
  }
});

// Tuyến đường GET /doimatkhau
app.get('/doimatkhau', authenticateToken, async (req, res) => {
  try {
    const viewPath = path.join(__dirname, 'views', 'doimatkhau.ejs');
    const errorViewPath = path.join(__dirname, 'views', 'error.ejs');
    
    try {
      await fs.access(viewPath);
    } catch (err) {
      console.error(`❌ Tệp doimatkhau.ejs không tồn tại tại: ${viewPath}`);
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
      currentPage: 'doimatkhau',  // Thêm dòng này
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

// Tuyến đường POST /doimatkhau
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
      const result = await pool.query('SELECT password FROM users WHERE username = $1', [username]);
      if (result.rows.length === 0) {
        console.warn(`⚠️ Không tìm thấy người dùng: ${username}`);
        return res.redirect(`/doimatkhau?error=${encodeURIComponent('Không tìm thấy người dùng')}`);
      }

      const user = result.rows[0];
      if (!bcrypt.compareSync(oldPassword, user.password)) {
        console.warn(`⚠️ Mật khẩu cũ không đúng cho người dùng: ${username}`);
        return res.redirect(`/doimatkhau?error=${encodeURIComponent('Mật khẩu cũ không đúng')}`);
      }

      const hashedNewPassword = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hashedNewPassword, username]);

      await pool.query(
        `INSERT INTO edit_history (table_name, record_id, old_values, new_values, changed_by, change_type, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          'users',
          username,
          JSON.stringify({ password: '******' }),
          JSON.stringify({ password: '******' }),
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

// ==================== GET /xbtk ====================
app.get('/xbtk', authenticateToken, async (req, res) => {
  let years = [new Date().getFullYear()]; // fallback an toàn

  try {
    const yearsRes = await pool.query(`
      SELECT DISTINCT EXTRACT(YEAR FROM created_at)::int AS year
      FROM metadata_chi_so
      WHERE created_at IS NOT NULL
      ORDER BY year DESC
    `);

    years = yearsRes.rows.map(r => r.year).filter(y => y && !isNaN(y));
  } catch (err) {
    console.error('Lỗi lấy năm cho /xbtk:', err.message);
  }

      res.render('xbtk', {
        user: req.user,
        currentPage: 'xbtk',  // Thêm dòng này
        years: years.length > 0 ? years : [new Date().getFullYear()],
        defaultYear: new Date().getFullYear(),
        error: null,
        success: req.query.success || null,
      });
});

// ==================== API LẤY DANH SÁCH METADATA (CHO BẢNG CHỌN CHỈ SỐ) ====================
app.get('/api/metadata/list', authenticateToken, async (req, res) => {
  try {
    let query = `
      SELECT id, stt, loai_so_lieu, mo_ta, don_vi, linh_vuc, chi_so, don_vi_cung_cap
      FROM metadata_chi_so
      WHERE true
    `;
    const params = [];

    if (req.query.donvi) {
      params.push(`%${req.query.donvi}%`);
      query += ` AND don_vi_cung_cap ILIKE $${params.length}`;
    }

    if (req.query.linhvuc) {
      params.push(req.query.linhvuc);
      query += ` AND linh_vuc = $${params.length}`;
    }

    query += ' ORDER BY stt ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching metadata list:', err);
    res.status(500).json({ error: 'Lỗi tải danh sách chỉ số' });
  }
});

// ==================== API LẤY OPTIONS CHO BỘ LỌC (động) ====================
app.get('/api/metadata/filters', authenticateToken, async (req, res) => {
  try {
    const [linhvucRes, donviRes] = await Promise.all([
      pool.query(`
        SELECT DISTINCT linh_vuc 
        FROM metadata_chi_so 
        WHERE linh_vuc IS NOT NULL 
        ORDER BY linh_vuc ASC
      `),
      pool.query(`
        SELECT DISTINCT don_vi_cung_cap 
        FROM metadata_chi_so 
        WHERE don_vi_cung_cap IS NOT NULL 
        ORDER BY don_vi_cung_cap ASC
      `)
    ]);

    res.json({
      linhvuc: linhvucRes.rows.map(r => r.linh_vuc),
      donvi: donviRes.rows.map(r => r.don_vi_cung_cap)
    });
  } catch (err) {
    console.error('Lỗi lấy filter options:', err);
    res.status(500).json({ error: 'Lỗi hệ thống' });
  }
});

// ==================== XUẤT METADATA (MÔ TẢ DỮ LIỆU) ====================

// Excel
app.get('/export/metadata/excel', authenticateToken, async (req, res) => {
  try {
    console.log('Export Excel params:', req.query);

    // Lấy danh sách ID được chọn từ query parameter 'selected'
    const selected = req.query.selected ? req.query.selected.split(',').map(Number).filter(n => !isNaN(n)) : null;
    const donvi = req.query.donvi;
    const linhvuc = req.query.linhvuc;

    let query = `
      SELECT stt, loai_so_lieu, mo_ta, don_vi, linh_vuc, chi_so, don_vi_cung_cap, luu_y
      FROM metadata_chi_so 
      WHERE true
    `;
    const params = [];
    let paramIndex = 1;

    // ƯU TIÊN: Nếu có selected (chọn checkbox) thì chỉ xuất các ID đó
    if (selected && selected.length > 0) {
      params.push(selected);
      query += ` AND id = ANY($${paramIndex}::int[])`;
      paramIndex++;
    } else {
      // Nếu không có selected thì mới áp dụng bộ lọc
      if (donvi) {
        params.push(`%${donvi}%`);
        query += ` AND don_vi_cung_cap ILIKE $${paramIndex}`;
        paramIndex++;
      }
      if (linhvuc) {
        params.push(linhvuc);
        query += ` AND linh_vuc = $${paramIndex}`;
        paramIndex++;
      }
    }

    query += ' ORDER BY stt ASC';

    const { rows: data } = await pool.query(query, params);
    console.log('Số hàng dữ liệu Excel:', data.length);

    if (data.length === 0) {
      return res.status(200).send('Không có dữ liệu phù hợp với bộ lọc');
    }

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Mô tả Chỉ Số');

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 8 },
      { header: 'Loại số liệu', key: 'loai_so_lieu', width: 25 },
      { header: 'Mô tả', key: 'mo_ta', width: 60 },
      { header: 'Đơn vị', key: 'don_vi', width: 12 },
      { header: 'Lĩnh vực', key: 'linh_vuc', width: 20 },
      { header: 'Chỉ số', key: 'chi_so', width: 25 },
      { header: 'Đơn vị cung cấp', key: 'don_vi_cung_cap', width: 35 },
      { header: 'Lưu ý', key: 'luu_y', width: 40 }
    ];

    data.forEach(row => sheet.addRow(row));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };

    sheet.addRow(['', '', `Tổng: ${data.length} chỉ số`, '', '', '', '', '']);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=metadata_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Lỗi xuất Excel metadata:', err);
    res.status(500).send('Lỗi xuất file Excel: ' + err.message);
  }
});
//CSV
app.get('/export/metadata/csv', authenticateToken, async (req, res) => {
  try {
    console.log('Export CSV params:', req.query);

    // Lấy danh sách ID được chọn từ query parameter
    const selected = req.query.selected
      ? req.query.selected.split(',').map(Number).filter(n => !isNaN(n))
      : null;
    const donvi = req.query.donvi;
    const linhvuc = req.query.linhvuc;

    let query = `
      SELECT stt, loai_so_lieu, mo_ta, don_vi, linh_vuc, chi_so, don_vi_cung_cap, luu_y
      FROM metadata_chi_so
      WHERE true
    `;
    const params = [];
    let paramIndex = 1;

    // ƯU TIÊN: Nếu có selected (chọn checkbox) thì chỉ xuất các ID đó
    if (selected && selected.length > 0) {
      params.push(selected);
      query += ` AND id = ANY($${paramIndex}::int[])`;
      paramIndex++;
    } else {
      // Nếu không có selected thì mới áp dụng bộ lọc
      if (donvi) {
        params.push(`%${donvi}%`);
        query += ` AND don_vi_cung_cap ILIKE $${paramIndex}`;
        paramIndex++;
      }
      if (linhvuc) {
        params.push(linhvuc);
        query += ` AND linh_vuc = $${paramIndex}`;
        paramIndex++;
      }
    }

    query += ' ORDER BY stt ASC';

    const { rows: data } = await pool.query(query, params);
    console.log('Số hàng dữ liệu CSV:', data.length);

    if (data.length === 0) {
      return res.status(200).send('Không có dữ liệu phù hợp với bộ lọc');
    }

    // Tạo CSV
    const headers = [
      'STT',
      'Loại số liệu',
      'Mô tả',
      'Đơn vị',
      'Lĩnh vực',
      'Chỉ số',
      'Đơn vị cung cấp',
      'Lưu ý'
    ];

    const escapeCSV = (value) => {
      if (value === null || value === undefined) return '';
      const str = value.toString().replace(/"/g, '""');
      return `"${str}"`;
    };

    let csv = headers.join(',') + '\n';

    data.forEach(row => {
      csv += [
        row.stt,
        row.loai_so_lieu,
        row.mo_ta,
        row.don_vi,
        row.linh_vuc,
        row.chi_so,
        row.don_vi_cung_cap,
        row.luu_y
      ].map(escapeCSV).join(',') + '\n';
    });

    // Dòng tổng
    csv += `,,,,,"Tổng: ${data.length} chỉ số",,\n`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=metadata_${Date.now()}.csv`
    );

    res.send('\uFEFF' + csv);

  } catch (err) {
    console.error('Lỗi xuất CSV metadata:', err);
    res.status(500).send('Lỗi xuất file CSV: ' + err.message);
  }
});
// PDF
app.get('/export/metadata/pdf', authenticateToken, async (req, res) => {
  try {
    console.log('Export PDF params:', req.query); // Debug

    const selected = req.query.selected ? req.query.selected.split(',').map(Number) : null;
    const donvi = req.query.donvi;
    const linhvuc = req.query.linhvuc;

    let query = `
      SELECT stt, loai_so_lieu, mo_ta, don_vi, linh_vuc, chi_so, don_vi_cung_cap, luu_y
      FROM metadata_chi_so WHERE true
    `;
    const params = [];

    if (selected && selected.length > 0) {
      params.push(selected);
      query += ` AND id = ANY($1::int[])`;
    } else {
      if (donvi) {
        params.push(`%${donvi}%`);
        query += ` AND don_vi_cung_cap ILIKE $1`;
      }
      if (linhvuc) {
        params.push(linhvuc);
        query += ` AND linh_vuc = $2`;
      }
    }

    query += ' ORDER BY stt ASC';

    const { rows: data } = await pool.query(query, params);

    if (data.length === 0) return res.status(404).send('Không có dữ liệu');

    const tableRows = data.map(row => `
      <tr>
        <td style="border:1px solid #ddd;padding:8px;text-align:center;">${row.stt || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${row.loai_so_lieu || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${row.mo_ta || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;text-align:center;">${row.don_vi || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${row.linh_vuc || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;text-align:center;">${row.chi_so || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${row.don_vi_cung_cap || '-'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${row.luu_y || '-'}</td>
      </tr>
    `).join('');

    const html = `
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Mô tả Chỉ Số</title>
    <style>
        body{font-family:DejaVu Sans,sans-serif;margin:40px;color:#333;}
        h1{color:#3B82F6;text-align:center;}
        table{width:100%;border-collapse:collapse;margin-top:20px;}
        th{background:#3B82F6;color:white;padding:12px;}
        td{border:1px solid #ddd;padding:8px;}
        .info{background:#f0f8ff;padding:15px;margin:20px 0;border-radius:8px;}
    </style></head>
    <body>
        <h1>BÁO CÁO MÔ TẢ CHỈ SỐ</h1>
        <p style="text-align:center;">Climate Smart City - TP. Hồ Chí Minh</p>
        <div class="info">
            <strong>Ngày xuất:</strong> ${new Date().toLocaleDateString('vi-VN')}<br>
            <strong>Số lượng chỉ số:</strong> ${data.length}
        </div>
        <table>
            <thead><tr>
                <th>STT</th><th>Loại số liệu</th><th>Mô tả</th><th>Đơn vị</th>
                <th>Lĩnh vực</th><th>Chỉ số</th><th>Đơn vị cung cấp</th><th>Lưu ý</th>
            </tr></thead>
            <tbody>${tableRows}</tbody>
        </table>
    </body></html>`;

    const options = { format: 'A4', orientation: 'landscape', border: '10mm' };

    pdf.create(html, options).toBuffer((err, buffer) => {
      if (err) return res.status(500).send('Lỗi tạo PDF');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename=metadata_${Date.now()}.pdf`);
      res.send(buffer);
    });
  } catch (err) {
    console.error('PDF metadata export error:', err);
    res.status(500).send('Lỗi xuất PDF');
  }
});

// ==================== XUẤT KẾT QUẢ ĐÁNH GIÁ ====================

// Excel
app.get('/export/result/excel', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { rows: data } = await pool.query(`
      SELECT m.stt, m.chi_so, m.mo_ta, m.don_vi, m.linh_vuc,
             r.gia_tri_thuc_te, r.diem_so, r.xep_loai
      FROM metadata_chi_so m
      LEFT JOIN ket_qua_danh_gia r ON m.id = r.metadata_id AND r.nam = $1
      ORDER BY m.stt ASC
    `, [year]);

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(`Kết quả ${year}`);

    sheet.columns = [
      { header: 'STT', key: 'stt', width: 8 },
      { header: 'Chỉ số', key: 'chi_so', width: 20 },
      { header: 'Mô tả', key: 'mo_ta', width: 50 },
      { header: 'Đơn vị', key: 'don_vi', width: 12 },
      { header: 'Lĩnh vực', key: 'linh_vuc', width: 15 },
      { header: 'Giá trị thực tế', key: 'gia_tri_thuc_te', width: 20 },
      { header: 'Điểm số', key: 'diem_so', width: 12 },
      { header: 'Xếp loại', key: 'xep_loai', width: 15 }
    ];

    data.forEach(row => sheet.addRow(row));

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10B981' } };

    const total = data.reduce((sum, r) => sum + (parseFloat(r.diem_so) || 0), 0);
    const avg = data.length ? (total / data.length).toFixed(2) : 0;
    sheet.addRow(['', '', '', '', '', `Tổng điểm: ${total.toFixed(2)}`, `Điểm TB: ${avg}`, '']);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=ket_qua_${year}_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Result Excel export error:', err);
    res.status(500).send('Lỗi xuất Excel kết quả');
  }
});

// CSV
app.get('/export/result/csv', authenticateToken, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const { rows: data } = await pool.query(`
      SELECT m.stt, m.chi_so, m.mo_ta, m.don_vi, m.linh_vuc,
             r.gia_tri_thuc_te, r.diem_so, r.xep_loai
      FROM metadata_chi_so m
      LEFT JOIN ket_qua_danh_gia r ON m.id = r.metadata_id AND r.nam = $1
      ORDER BY m.stt ASC
    `, [year]);

    const headers = ['STT','Chỉ số','Mô tả','Đơn vị','Lĩnh vực','Giá trị thực tế','Điểm số','Xếp loại'];
    const rows = data.map(r => [
      r.stt || '',
      r.chi_so || '',
      `"${(r.mo_ta || '').replace(/"/g, '""')}"`,
      r.don_vi || '',
      r.linh_vuc || '',
      r.gia_tri_thuc_te || '',
      r.diem_so || '',
      r.xep_loai || ''
    ]);

    const csv = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=ket_qua_${year}_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).send('Lỗi xuất CSV');
  }
});

// PDF kết quả (tạm thời chưa triển khai)
app.get('/export/result/pdf', authenticateToken, (req, res) => {
  res.status(501).json({ error: 'Chưa hỗ trợ xuất PDF cho kết quả đánh giá' });
});
// Route POST /upload/pdf-to-word (GIỮ NGUYÊN – DÙNG `upload` ĐÚNG)
app.post('/upload/pdf-to-word', authenticateToken, checkRole('admin'), upload.single('pdfFile'), async (req, res) => {
  try {
    console.log('File received:', req.file);

    if (!req.file) {
      return res.redirect('/xbtk?error=Không có file được tải lên hoặc file không hợp lệ');
    }

    // Lưu vào DB (dùng buffer)
    await pool.query(
      `INSERT INTO file_uploads (filename, original_name, mimetype, size, uploaded_by, file_data)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        req.file.filename || `file_${Date.now()}`,
        req.file.originalname,
        req.file.mimetype,
        req.file.size,
        req.user.username,
        req.file.buffer
      ]
    );

    res.redirect('/xbtk?success=Tải file lên thành công');
  } catch (err) {
    console.error('Lỗi POST /upload/pdf-to-word:', err.message);
    const errorMsg = err.message.includes('table') ? 'Lỗi cơ sở dữ liệu'
                   : err.message.includes('permission') ? 'Lỗi quyền'
                   : 'Lỗi khi tải lên file';
    res.redirect(`/xbtk?error=${encodeURIComponent(errorMsg)}`);
  }
});
// ==================== EXPORT PDF ====================
app.get('/export/pdf', authenticateToken, async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    const result = await pool.query(
      `
      SELECT 
        a.year,
        d.name AS domain_name,
        i.name AS indicator_name,
        a.value,
        a.score_awarded,
        a.date
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY d.domain_id, i.indicator_id
      `,
      [city, year]
    );

    const data = result.rows;
    const doc = new PDFDocument({ margin: 50 });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="baocao_csc_${year}.pdf"`);

    doc.pipe(res);

    // Tiêu đề
    doc.fontSize(18).text('BÁO CÁO CLIMATE SMART CITY', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Thành phố: ${city}`);
    doc.text(`Năm đánh giá: ${year}`);
    doc.text(`Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`);
    doc.moveDown(2);

    // Nội dung
    data.forEach((row, index) => {
      doc
        .fontSize(13)
        .text(`${index + 1}. ${row.indicator_name}`, { underline: true });
      doc.fontSize(11).text(`Lĩnh vực: ${row.domain_name}`);
      doc.text(`Giá trị: ${row.value ?? 'N/A'}`);
      doc.text(`Điểm: ${row.score_awarded ?? 'N/A'}`);
      doc.text(`Ngày cập nhật: ${row.date ? new Date(row.date).toLocaleDateString('vi-VN') : 'N/A'}`);
      doc.moveDown();
    });

    doc.end();
  } catch (err) {
    console.error('Lỗi export PDF:', err);
    res.redirect('/xbtk?error=Lỗi khi xuất báo cáo PDF');
  }
});

// ====================== HÀM TÍNH ĐIỂM CHUNG (ĐỒNG BỘ DASHBOARD & EXPORT) ======================
// Đặt hàm này ở đầu file app.js, trước các app.get / app.post
async function calculateClimateSmartScores(pool, city, year) {
  const client = await pool.connect();
  try {
    // Lấy Domains
    const domainsRes = await client.query('SELECT * FROM Domains ORDER BY domain_id');
    const domains = domainsRes.rows || [];

    // Lấy Assessments + trọng số chỉ số (giống dashboard)
    const assessmentsRes = await client.query(`
      SELECT 
        a.domain_id,
        a.score_awarded,
        iw.weight_within_domain
      FROM Assessments_Template a
      LEFT JOIN indicatorweights iw 
        ON a.indicator_id = iw.indicator_id 
       AND a.domain_id = iw.domain_id
      WHERE a.city = $1 AND a.year = $2
    `, [city, year]);

    const assessments = assessmentsRes.rows || [];

    // Lấy trọng số lĩnh vực
    const domainWeightsRes = await client.query('SELECT domain_id, weight FROM domainweights');
    const domainWeights = {};
    domainWeightsRes.rows.forEach(row => {
      domainWeights[row.domain_id] = Number(row.weight) || 0;
    });

    // TÍNH ĐIỂM TỪNG LĨNH VỰC (copy chính xác logic từ dashboard)
    const domainScores = {};

    domains.forEach(domain => {
      const domainAssessments = assessments.filter(a => a.domain_id === domain.domain_id);

      const validAssessments = domainAssessments.filter(a =>
        a.score_awarded !== null &&
        a.score_awarded !== undefined &&
        a.score_awarded !== '-' &&
        !isNaN(a.score_awarded)
      );

      if (validAssessments.length === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      const totalValidWeight = validAssessments.reduce(
        (sum, a) => sum + (Number(a.weight_within_domain) || 0), 0
      );

      if (totalValidWeight === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      const score = validAssessments.reduce((sum, a) => {
        const Zi = Number(a.score_awarded);
        const wi = Number(a.weight_within_domain) || 0;
        const normalizedWeight = wi / totalValidWeight;
        return sum + normalizedWeight * Zi;
      }, 0);

      domainScores[domain.domain_id] = Number(score.toFixed(3));
    });

    // Tính tổng điểm (có trọng số lĩnh vực)
    const totalScoreRaw = Object.keys(domainScores).reduce((sum, domainId) => {
      const score = domainScores[domainId];
      const weight = domainWeights[domainId] || 0;
      return sum + (score * weight);
    }, 0);

    const totalScore = Number(totalScoreRaw.toFixed(3));

    // Xếp hạng tổng thể (giống dashboard)
    let overallLevel = 1;
    let overallDescription = 'Thành phố chưa tích hợp yếu tố khí hậu vào quản lý và quy hoạch; dữ liệu rời rạc, thiếu số hóa; chủ yếu phản ứng thụ động trước rủi ro khí hậu.';

    if (totalScore >= 81) {
      overallLevel = 5;
      overallDescription = 'Thành phố phát thải thấp hoặc trung hòa carbon, hạ tầng thông minh, thích ứng với biến đổi khí hậu, có khả năng nhân rộng mô hình.';
    } else if (totalScore >= 61) {
      overallLevel = 4;
      overallDescription = 'Thành phố vận hành dựa trên dữ liệu số, quản trị thông minh, giảm phát thải rõ rệt, thích ứng khí hậu chủ động; liên kết tốt giữa quy hoạch, công nghệ và chính sách.';
    } else if (totalScore >= 41) {
      overallLevel = 3;
      overallDescription = 'Các trụ cột của Thành phố thông minh với khí hậu đã được hình thành, với sự hiện diện của hệ thống dữ liệu, bộ chỉ số và các kế hoạch thích ứng, giảm phát thải.';
    } else if (totalScore >= 21) {
      overallLevel = 2;
      overallDescription = 'Đã có một số chính sách đơn lẻ, nhưng thiếu liên kết liên ngành; công nghệ thông minh và giải pháp khí hậu mới ở mức thí điểm.';
    }

    return {
      totalScore: Math.round(totalScore),
      domainScores,
      overallLevel,
      overallDescription,
      domains,           // để lấy tên lĩnh vực khi xuất Excel
      assessments
    };

  } finally {
    client.release();
  }
}
// ==================== XUẤT BÁO CÁO TỔNG HỢP - EXCEL (ĐẸP & ĐẦY ĐỦ) ====================
app.get('/export/comprehensive/excel', authenticateToken, async (req, res) => {
  try {
    const yearsParam = req.query.year || new Date().getFullYear().toString();
    const linhvucFilter = req.query.linhvuc || '';
    let years = yearsParam.split(',').map(y => parseInt(y.trim())).filter(y => !isNaN(y));

    if (years.length === 0) years.push(new Date().getFullYear());

    const city = 'TP. Hồ Chí Minh';
    const year = years[0];

    const metrics = await calculateClimateSmartScores(pool, city, year);
    const { totalScore, domainScores, overallLevel, overallDescription, domains } = metrics;

    const domainNames = {};
    domains.forEach(d => {
      domainNames[d.domain_id] = d.name || `Lĩnh vực ${d.domain_id}`;
    });

    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();

    // ==================== SHEET 1: TRANG BÌA ====================
    const cover = workbook.addWorksheet('Trang Bìa');
    cover.mergeCells('A1:H25');
    const titleCell = cover.getCell('A1');
    titleCell.value = 'BÁO CÁO TỔNG HỢP ĐÁNH GIÁ\nCLIMATE SMART CITY\nTP. HỒ CHÍ MINH';
    titleCell.font = { name: 'Calibri', size: 24, bold: true, color: { argb: 'FF1E40AF' } };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    cover.getCell('A28').value = `Năm đánh giá: ${year}`;
    cover.getCell('A28').font = { name: 'Calibri', size: 14, bold: true };

    cover.getCell('A30').value = `Ngày xuất: ${new Date().toLocaleDateString('vi-VN')}`;
    cover.getCell('A30').font = { name: 'Calibri', size: 13 };

    // ==================== SHEET 2: TỔNG QUAN ====================
    const summary = workbook.addWorksheet('Tổng Quan');
    summary.columns = [
      { width: 12 },  // Cột A: Điểm
      { width: 15 },  // Cột B: Xếp hạng
      { width: 48 },  // Cột C: Mức độ đánh giá (rộng hơn)
      { width: 18 }
    ];

    summary.addRow(['BÁO CÁO ĐÁNH GIÁ CLIMATE SMART CITY']).font = { name: 'Calibri', size: 16, bold: true };
    summary.mergeCells('A1:D1');

    summary.addRow(['']);
    const totalRow = summary.addRow(['ĐIỂM TỔNG HỢP', totalScore, '/ 100', `${totalScore}%`]);
    totalRow.getCell(2).font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF166534' } };

    summary.addRow(['CẤP ĐỘ', `${overallLevel} SAO`]);
    const descRow = summary.addRow(['ĐÁNH GIÁ', overallDescription]);
    descRow.getCell(2).alignment = { wrapText: true };

    summary.addRow(['']);
    summary.addRow(['ĐIỂM CHI TIẾT THEO 5 LĨNH VỰC']);

    const headerRow = summary.addRow(['Lĩnh vực', 'Điểm đạt được', 'Tỷ lệ (%)']);
    headerRow.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };

    for (let i = 1; i <= 5; i++) {
      const score = domainScores[i] || 0;
      const name = domainNames[i] || `Lĩnh vực ${i}`;
      summary.addRow([name, score.toFixed(2), `${totalScore}%`]);
    }

    // ==================== PHẦN CHÚ THÍCH THANG ĐIỂM (TRÌNH BÀY ĐẸP) ====================
    summary.addRow(['']); // dòng trống cách biệt

    // Tiêu đề phần chú thích
    const titleNote = summary.addRow(['THANG ĐIỂM MỨC ĐỘ ĐÁNH GIÁ THÀNH PHỐ THÔNG MINH VỚI KHÍ HẬU']);
    titleNote.font = { name: 'Calibri', size: 12, bold: true };
    titleNote.alignment = { horizontal: 'center' };
    summary.mergeCells(`A${titleNote.number}:D${titleNote.number}`);

    // Header của bảng chú thích
    const noteHeader = summary.addRow(['Điểm', 'Xếp hạng', 'Mức độ đánh giá', '']);
    noteHeader.font = { name: 'Calibri', size: 11, bold: true };
    noteHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
    noteHeader.alignment = { horizontal: 'center', vertical: 'middle' };

    // Dữ liệu các mức
    const notes = [
      ['81 - 100', 'Năm sao', 'Thành phố phát thải thấp hoặc trung hòa carbon, hạ tầng thông minh, thích ứng với biến đổi khí hậu, có khả năng nhân rộng mô hình.'],
      ['61 - 80',  'Bốn sao', 'Thành phố vận hành dựa trên dữ liệu số, quản trị thông minh, giảm phát thải rõ rệt, thích ứng khí hậu chủ động; liên kết tốt giữa quy hoạch, công nghệ và chính sách.'],
      ['41 - 60',  'Ba sao',  'Các trụ cột của Thành phố thông minh với khí hậu đã được hình thành, với sự hiện diện của hệ thống dữ liệu, bộ chỉ số và các kế hoạch thích ứng, giảm phát thải.'],
      ['21 - 40',  'Hai sao', 'Đã có một số chính sách đơn lẻ, nhưng thiếu liên kết liên ngành; công nghệ thông minh và giải pháp khí hậu mới ở mức thí điểm.'],
      ['0 - 20',   'Một sao', 'Thành phố chưa tích hợp yếu tố khí hậu vào quản lý và quy hoạch; dữ liệu rời rạc, thiếu số hóa; chủ yếu phản ứng thụ động trước rủi ro khí hậu.']
    ];

    notes.forEach(note => {
      const row = summary.addRow(note);
      row.alignment = { vertical: 'top', wrapText: true };
      
      // Căn giữa cho cột Điểm và Xếp hạng
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).alignment = { horizontal: 'center' };
    });

    // Áp dụng đường viền cho toàn bộ bảng chú thích
    const startRow = titleNote.number;           // dòng tiêu đề
    const endRow   = summary.rowCount;           // dòng cuối cùng

    for (let r = startRow; r <= endRow; r++) {
      for (let c = 1; c <= 3; c++) {   // chỉ áp dụng border cho 3 cột chính
        const cell = summary.getCell(r, c);
        cell.border = {
          top:    { style: 'thin' },
          left:   { style: 'thin' },
          bottom: { style: 'thin' },
          right:  { style: 'thin' }
        };
      }
    }

    // Điều chỉnh chiều cao các dòng mô tả (vì nội dung dài)
    for (let r = noteHeader.number + 1; r <= endRow; r++) {
      summary.getRow(r).height = 65;   // bạn có thể chỉnh số này (50~80) cho vừa mắt
    }
    // ==================== SHEET 3: CHI TIẾT CHỈ SỐ ====================
    const detailRes = await pool.query(`
      SELECT m.stt, m.loai_so_lieu, m.linh_vuc, m.chi_so, m.mo_ta AS mo_ta_chi_so,
             m.don_vi, m.don_vi_cung_cap, m.luu_y,
             a.value AS gia_tri_thuc_te, a.score_awarded AS diem_dat_duoc, a.level AS cap_do
      FROM metadata_chi_so m
      LEFT JOIN Assessments_Template a 
        ON m.id = a.indicator_id 
        AND a.city = $1 AND a.year = $2
      WHERE ($3 = '' OR m.linh_vuc = $3)
      ORDER BY m.linh_vuc, m.stt
    `, [city, year, linhvucFilter]);

    const detailData = detailRes.rows || [];

    if (detailData.length > 0) {
      const detailSheet = workbook.addWorksheet('Chi Tiết Chỉ Số');
      detailSheet.columns = [
        { header: 'STT', key: 'stt', width: 8 },
        { header: 'Loại số liệu', key: 'loai_so_lieu', width: 20 },
        { header: 'Lĩnh vực', key: 'linh_vuc', width: 25 },
        { header: 'Chỉ số', key: 'chi_so', width: 40 },
        { header: 'Mô tả chỉ số', key: 'mo_ta_chi_so', width: 70 },
        { header: 'Giá trị thực tế', key: 'gia_tri_thuc_te', width: 20 },
        { header: 'Đơn vị', key: 'don_vi', width: 15 },
        { header: 'Đơn vị cung cấp', key: 'don_vi_cung_cap', width: 30 },
        { header: 'Điểm đạt', key: 'diem_dat_duoc', width: 12 },
        { header: 'Cấp độ', key: 'cap_do', width: 12 },
        { header: 'Lưu ý', key: 'luu_y', width: 45 }
      ];

      const header = detailSheet.getRow(1);
      header.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };

      detailData.forEach(row => detailSheet.addRow(row));
    }

    // Gửi file
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=Baocao_ClimateSmart_${year}_Excel_${Date.now()}.xlsx`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Lỗi xuất báo cáo Excel:', err.message);
    res.status(500).send('Lỗi khi xuất báo cáo Excel: ' + err.message);
  }
});
// Tuyến đường GET /lichsu
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
      currentPage: 'lichsu',  // Thêm dòng này
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
// Tuyến đường GET /hsnd
app.get('/hsnd', authenticateToken, checkRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT username, role FROM users');
    const users = result.rows;
    res.render('hsnd', {
      user: req.user,
      currentPage: 'hsnd',  // Thêm dòng này
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

// Tuyến đường POST /hsnd/update-role
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

// Tuyến đường GET /about
app.get('/about', (req, res) => {
  res.render('about');
});

// Tuyến đường GET /contact
app.get('/contact', (req, res) => {
  try {
    res.render('contact', { message: null });
  } catch (error) {
    console.error('Lỗi khi render contact.ejs:', error);
    res.status(500).send('Lỗi máy chủ nội bộ. Vui lòng thử lại sau.');
  }
});

// Tuyến đường POST /contact
app.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (!name || !email || !message) {
      return res.render('contact', {
        message: { type: 'error', text: 'Vui lòng điền đầy đủ thông tin bắt buộc!' }
      });
    }

    res.render('contact', {
      message: { type: 'success', text: 'Tin nhắn đã được gửi thành công!' }
    });
  } catch (error) {
    console.error('Lỗi trong POST /contact:', error);
    res.render('contact', {
      message: { type: 'error', text: 'Lỗi khi gửi tin nhắn. Vui lòng thử lại!' }
    });
  }
});

// Tuyến đường POST /refresh-token
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
// Tuyến đường GET /motadulieu - Đồng bộ với phong cách /hsnd
app.get('/motadulieu', authenticateToken, async (req, res) => {
  try {
    res.render('motadulieu', {
      title: 'Mô Tả Dữ Liệu - Climate Smart City',
      user: req.user,
      currentPage: 'motadulieu',  // Thêm dòng này
      error: req.query.error || null,
      success: req.query.success || null
    });
  } catch (err) {
    console.error('❌ Lỗi GET /motadulieu:', err.message);
    res.render('motadulieu', {
      title: 'Mô Tả Dữ Liệu - Climate Smart City',
      user: req.user || null,
      error: 'Lỗi khi tải trang mô tả dữ liệu',
      success: null
    });
  }
});
// Tuyến đường GET /logout
app.get('/logout', (req, res) => {
  res.clearCookie('token');
  res.redirect('/?success=Đăng xuất thành công');
});

// Tuyến đường GET /charts - Trang đồ thị đánh giá
app.get('/charts', authenticateToken, async (req, res) => {
  let client;
  try {
    const user = req.user;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const city = 'TP. Hồ Chí Minh';

    client = await pool.connect();

    // 1. Lấy Domains
    const domainsRes = await client.query('SELECT * FROM Domains ORDER BY domain_id');
    const domains = domainsRes.rows || [];

    // 2. Lấy Indicators
    const indicatorsRes = await client.query('SELECT * FROM Indicators ORDER BY domain_id, indicator_id');
    const indicators = indicatorsRes.rows || [];

    // 3. Lấy Assessments + trọng số chỉ số
    const assessmentsRes = await client.query(`
      SELECT 
        a.assessment_id,
        a.domain_id,
        a.indicator_id,
        a.value,
        a.score_awarded,
        a.level,
        a.year,
        COALESCE(a.date::text, '') AS date,
        d.name AS domain_name,
        i.name AS indicator_name,
        COALESCE(iw.weight_within_domain, 0) AS weight_within_domain
      FROM Assessments_Template a
      JOIN Domains d ON a.domain_id = d.domain_id
      JOIN Indicators i ON a.indicator_id = i.indicator_id
      LEFT JOIN indicatorweights iw ON a.indicator_id = iw.indicator_id AND a.domain_id = iw.domain_id
      WHERE a.city = $1 AND a.year = $2
      ORDER BY a.domain_id, a.indicator_id
    `, [city, year]);

    const assessments = assessmentsRes.rows || [];

    // 4. Trọng số lĩnh vực
    const domainWeightsRes = await client.query('SELECT domain_id, weight FROM domainweights');
    const domainWeights = {};
    domainWeightsRes.rows.forEach(row => {
      domainWeights[row.domain_id] = Number(row.weight) || 0;
    });

    // 5. TÍNH ĐIỂM TỪNG LĨNH VỰC
    const domainScores = {};

    domains.forEach(domain => {
      const domainAssessments = assessments.filter(a => a.domain_id === domain.domain_id);
      const validAssessments = domainAssessments.filter(a =>
        a.score_awarded !== null &&
        a.score_awarded !== undefined &&
        a.score_awarded !== '-' &&
        !isNaN(a.score_awarded)
      );

      if (validAssessments.length === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      const totalValidWeight = validAssessments.reduce(
        (sum, a) => sum + (Number(a.weight_within_domain) || 0), 0
      );

      if (totalValidWeight === 0) {
        domainScores[domain.domain_id] = 0;
        return;
      }

      const score = validAssessments.reduce((sum, a) => {
        const Zi = Number(a.score_awarded);
        const wi = Number(a.weight_within_domain) || 0;
        const normalizedWeight = wi / totalValidWeight;
        return sum + normalizedWeight * Zi;
      }, 0);

      domainScores[domain.domain_id] = Number(score.toFixed(3));
    });

    // 6. Tính tổng điểm
    const totalScoreRaw = Object.values(domainScores).reduce((sum, score) => {
      const domainId = Object.keys(domainScores).find(key => domainScores[key] === score);
      const weight = domainWeights[domainId] || 0;
      return sum + (score * weight);
    }, 0);
    const totalScore = Number(totalScoreRaw.toFixed(3));

    // 7. Xếp hạng tổng thể
    let overallLevel = 1;
    let overallDescription = 'Thành phố chưa tích hợp yếu tố khí hậu vào quản lý và quy hoạch; dữ liệu rời rạc, thiếu số hóa; chủ yếu phản ứng thụ động trước rủi ro khí hậu.';

    if (totalScore >= 81) { overallLevel = 5; overallDescription = 'Thành phố phát thải thấp hoặc trung hòa carbon, hạ tầng thông minh, thích ứng với biến đổi khí hậu, có khả năng nhân rộng mô hình.'; }
    else if (totalScore >= 61) { overallLevel = 4; overallDescription = 'Thành phố vận hành dựa trên dữ liệu số, quản trị thông minh, giảm phát thải rõ rệt, thích ứng khí hậu chủ động; liên kết tốt giữa quy hoạch, công nghệ và chính sách.'; }
    else if (totalScore >= 41) { overallLevel = 3; overallDescription = 'Các trụ cột của Thành phố thông minh với khí hậu đã được hình thành, với sự hiện diện của hệ thống dữ liệu, bộ chỉ số và các kế hoạch thích ứng, giảm phát thải.'; }
    else if (totalScore >= 21) { overallLevel = 2; overallDescription = 'Đã có một số chính sách đơn lẻ, nhưng thiếu liên kết liên ngành; công nghệ thông minh và giải pháp khí hậu mới ở mức thí điểm.'; }

    // 8. Danh sách năm có dữ liệu
    const yearsRes = await client.query('SELECT DISTINCT year FROM Assessments_Template WHERE city = $1 ORDER BY year DESC', [city]);
    const years = yearsRes.rows.map(r => r.year);

    // 9. Debug log
    console.log('===== CHARTS DEBUG =====');
    console.log('Year:', year);
    console.log('Domain Scores:', domainScores);
    console.log('Assessments Count:', assessments.length);
    console.log('========================');

    // 10. Render trang charts
    res.render('charts', {
      user: req.user,
      currentPage: 'charts',
      domains: domains,
      indicators: indicators,
      assessments: assessments,
      domainScores: domainScores,
      totalScore: Math.round(totalScore),
      overallLevel: overallLevel,
      overallDescription: overallDescription,
      years: years.length > 0 ? years : [2024, 2025, 2026],
      selectedYear: year,
      error: null,
      success: null
    });

  } catch (err) {
    console.error('LỖI CHARTS:', err.message);
    res.render('charts', {
      user: req.user || null,
      domains: [],
      indicators: [],
      assessments: [],
      domainScores: {1:0, 2:0, 3:0, 4:0, 5:0},
      totalScore: 0,
      overallLevel: 1,
      overallDescription: 'Không có dữ liệu để hiển thị.',
      years: [2024, 2025, 2026],
      selectedYear: new Date().getFullYear(),
      error: 'Không thể tải dữ liệu. Vui lòng thử lại sau.',
      success: null
    });
  } finally {
    if (client) client.release();
  }
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