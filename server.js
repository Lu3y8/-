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

// ✅ 直接把描述文件内容写死在路由里，确保能下载
app.get('/profile.mobileconfig', (req, res) => {
  const mobileconfig = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.profile-service</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadUUID</key>
            <string>3C4DC7D2-E475-3375-489C-0BB8D737A654</string>
            <key>PayloadIdentifier</key>
            <string>com.example.udid-collect</string>
            <key>URL</key>
            <string>https://jx-peizhi.onrender.com/receive</string>
            <key>RequestAttributes</key>
            <array>
                <string>UDID</string>
                <string>VERSION</string>
                <string>PRODUCT</string>
                <string>SERIAL</string>
            </array>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>Device Information</string>
    <key>PayloadIdentifier</key>
    <string>com.example.profile</string>
    <key>PayloadUUID</key>
    <string>3C4DC7D2-E475-3375-489C-0BB8D737A653</string>
    <key>PayloadOrganization</key>
    <string>Device Info Collector</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="profile.mobileconfig"');
  res.send(mobileconfig);
});

// 静态文件（保留，备用）
app.use(express.static('.'));

// 手机测试页面
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
              status.innerHTML = '✅ 测试数据发送成功！<br>现在去 <a href="/devices">/devices</a> 查看。';
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

// 接收设备数据
app.post('/receive', async (req, res) => {
  try {
    let deviceInfo = {};
    if (req.is('application/x-apple-aspen-config') || req.is('text/*')) {
      deviceInfo = plist.parse(req.body);
    } else {
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

    // 真实设备：302 重定向到结果页
    const udid = encodeURIComponent(deviceInfo.UDID || '无');
    res.redirect(302, `/result?udid=${udid}&ip=${encodeURIComponent(ip)}&city=${encodeURIComponent(geo.city)}`);
  } catch (error) {
    console.error('❌ 处理失败:', error);
    res.redirect(302, '/result?error=1');
  }
});

// 结果展示页
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

// 根路径友好提示
app.get('/', (req, res) => {
  res.send('<h2>✅ 服务运行中</h2><p>请使用正确的地址安装描述文件。</p>');
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
  });
});
