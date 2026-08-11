const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_k5hlBvdIsPA4@ep-plain-dawn-ayjfr136-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true'
});

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

    // 存入数据库
    await pool.query(
      `INSERT INTO devices (udid, version, product, serial, ip, city, isp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deviceInfo.UDID || '', deviceInfo.VERSION || '', deviceInfo.PRODUCT || '', deviceInfo.SERIAL || '', ip, geo.city, geo.isp]
    );

    console.log('✅ 收到设备并已存入 Neon');

    // 🔥 临时：返回一个显示信息的网页，安装后自动跳转
    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>设备信息已收到</title></head>
      <body style="font-family: -apple-system, sans-serif; padding: 20px;">
        <h2>✅ 设备信息已成功收集</h2>
        <p><strong>UDID:</strong> ${deviceInfo.UDID || '无'}</p>
        <p><strong>IP:</strong> ${ip}</p>
        <p><strong>城市:</strong> ${geo.city}</p>
        <p>此页面仅用于调试，成功后我们将改回无跳转版本。</p>
      </body>
      </html>
    `;
    res.send(html);
  } catch (error) {
    console.error('❌ 处理失败:', error);
    res.status(500).send('处理失败，请查看服务器日志');
  }
});

// 查看所有数据
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
