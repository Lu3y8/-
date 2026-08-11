const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ Neon 连接字符串（已加 uselibpqcompat=true，与新服务无关，数据库不变）
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_k5hlBvdIsPA4@ep-plain-dawn-ayjfr136-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true'
});

// 自动建表
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        udid TEXT,
        version TEXT,
        product TEXT,
        serial TEXT,
        ip TEXT,
        city TEXT,
        isp TEXT,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ 数据库表已就绪');
  } catch (err) {
    console.error('❌ 建表失败:', err);
  }
}

app.use(cors());
app.use(express.text({ type: '*/*' }));

app.use((req, res, next) => {
  if (req.path.endsWith('.mobileconfig')) {
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="device.mobileconfig"');
  }
  next();
});

app.use(express.static('.'));

function getEmptyProfile() {
  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array></array>
    <key>PayloadDisplayName</key>
    <string>Device Info</string>
    <key>PayloadIdentifier</key>
    <string>com.example.empty</string>
    <key>PayloadUUID</key>
    <string>${uuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;
}

app.post('/receive', async (req, res) => {
  try {
    const rawBody = req.body;
    const deviceInfo = plist.parse(rawBody);

    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    let geo = { city: '未知', isp: '未知' };
    try {
      const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,isp`, { timeout: 3000 });
      if (geoRes.data.status === 'success') {
        geo = { city: geoRes.data.city, isp: geoRes.data.isp };
      }
    } catch (e) {}

    await pool.query(
      `INSERT INTO devices (udid, version, product, serial, ip, city, isp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deviceInfo.UDID || '', deviceInfo.VERSION || '', deviceInfo.PRODUCT || '', deviceInfo.SERIAL || '', ip, geo.city, geo.isp]
    );

    console.log('✅ 收到设备并已存入 Neon');

    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.send(getEmptyProfile());
  } catch (error) {
    console.error('❌ 处理失败:', error);
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.send(getEmptyProfile());
  }
});

app.get('/devices', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM devices ORDER BY received_at DESC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
  });
});
