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
app.use(express.json()); // 支持 JSON 格式的测试请求

app.use((req, res, next) => {
  if (req.path.endsWith('.mobileconfig')) {
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.setHeader('Content-Disposition', 'attachment; filename="device.mobileconfig"');
  }
  next();
});

app.use(express.static('.'));

// 📱 手机测试页面（访问 /test 即可看到按钮）
app.get('/test', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>设备数据测试</title></head>
    <body style="font-family: -apple-system, sans-serif; padding: 20px;">
      <h2>🔧 设备数据上报测试</h2>
      <p>点击下面的按钮，将模拟发送一条测试数据到服务器。</p>
      <button onclick="sendTest()" style="padding: 12px 24px; font-size: 18px; background: #007AFF; color: white; border: none; border-radius: 8px;">📤 发送测试数据</button>
      <p id="status" style="margin-top: 20px;"></p>
      <script>
        async function sendTest() {
          const status = document.getElementById('status');
          status.textContent = '发送中...';
          try {
            const xml = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>UDID</key><string>test-udid-99999</string><key>VERSION</key><string>17.0</string><key>PRODUCT</key><string>iPhone12,1</string><key>SERIAL</key><string>test-serial-123</string></dict></plist>';
            const res = await fetch('/receive', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-apple-aspen-config' },
              body: xml
            });
            if (res.ok) {
              status.innerHTML = '✅ 测试数据发送成功！<br>现在去 <a href="/devices">/devices</a> 查看，应该能看到一条 UDID 为 test-udid-99999 的数据。';
            } else {
              status.textContent = '❌ 发送失败，状态码：' + res.status;
            }
          } catch(e) {
            status.textContent = '❌ 请求出错：' + e.message;
          }
        }
      </script>
    </body>
    </html>
  `);
});

// 接收数据的核心接口（支持 XML 和 JSON 测试）
app.post('/receive', async (req, res) => {
  try {
    let deviceInfo = {};
    // 根据 Content-Type 解析
    if (req.is('application/x-apple-aspen-config') || req.is('text/*')) {
      deviceInfo = plist.parse(req.body);
    } else if (req.is('application/json')) {
      deviceInfo = req.body; // 来自测试页面的 JSON
    } else {
      // 尝试作为 XML 解析
      deviceInfo = plist.parse(req.body);
    }

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

    // 判断是否是真实设备请求（通常希望返回描述文件），还是测试请求
    if (req.is('application/x-apple-aspen-config') || req.headers['user-agent']?.includes('Profile')) {
      // 真实设备：返回 302 重定向到结果页
      const udid = encodeURIComponent(deviceInfo.UDID || '无');
      res.redirect(302, `/result?udid=${udid}&ip=${encodeURIComponent(ip)}&city=${encodeURIComponent(geo.city)}`);
    } else {
      // 测试请求：返回 JSON
      res.json({ success: true, udid: deviceInfo.UDID, ip });
    }
  } catch (error) {
    console.error('❌ 处理失败:', error);
    res.status(500).json({ error: error.message });
  }
});

// 结果页
app.get('/result', (req, res) => {
  const { udid, ip, city, error } = req.query;
  if (error) return res.send('<h2>❌ 数据接收失败</h2>');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="font-family: -apple-system, sans-serif; padding: 20px;"><h2>✅ 设备信息已成功收集</h2><p><strong>UDID:</strong> ${udid}</p><p><strong>IP:</strong> ${ip}</p><p><strong>城市:</strong> ${city}</p><p>调试完成后将恢复无跳转版本。</p></body></html>`);
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
