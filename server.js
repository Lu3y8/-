const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const { Pool } = require('pg');
const forge = require('node-forge');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_k5hlBvdIsPA4@ep-plain-dawn-ayjfr136-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&uselibpqcompat=true'
});

// 自签名 CA 和签名证书的全局缓存（只生成一次）
let caCertPem, caKeyPem, signCertPem, signKeyPem;

function generateCerts() {
  // 生成 CA 密钥对
  const caKeys = forge.pki.rsa.generateKeyPair(2048);
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = caKeys.publicKey;
  caCert.serialNumber = '01';
  caCert.validity.notBefore = new Date();
  caCert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000); // 10 年
  caCert.setSubject([{ name: 'commonName', value: 'My Device Info CA' }]);
  caCert.setIssuer(caCert.subject.attributes);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true }
  ]);
  caCert.sign(caKeys.privateKey, forge.md.sha256.create());

  // 生成签名密钥对
  const signKeys = forge.pki.rsa.generateKeyPair(2048);
  const signCert = forge.pki.createCertificate();
  signCert.publicKey = signKeys.publicKey;
  signCert.serialNumber = '02';
  signCert.validity.notBefore = new Date();
  signCert.validity.notAfter = new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000);
  signCert.setSubject([{ name: 'commonName', value: 'My Profile Signer' }]);
  signCert.setIssuer(caCert.subject.attributes);
  signCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true }
  ]);
  signCert.sign(caKeys.privateKey, forge.md.sha256.create());

  caCertPem = forge.pki.certificateToPem(caCert);
  caKeyPem = forge.pki.privateKeyToPem(caKeys.privateKey);
  signCertPem = forge.pki.certificateToPem(signCert);
  signKeyPem = forge.pki.privateKeyToPem(signKeys.privateKey);
}

// 签名描述文件函数
function signMobileconfig(xmlContent) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = new forge.util.ByteBuffer(xmlContent, 'utf8');
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

// 初始化数据库和证书
async function initAll() {
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
  generateCerts();
  console.log('🔐 签名证书已生成');
}

// 中间件
app.use(cors());
app.use(express.text({ type: '*/*' }));

// 请求日志
app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 首页
app.get('/', (req, res) => {
  res.send('<h2>✅ 服务运行中</h2><p>请访问 <a href="/setup">/setup</a> 按指引安装</p>');
});

// 安装指引页
app.get('/setup', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>安装步骤</title></head>
    <body style="font-family: -apple-system, sans-serif; padding: 20px;">
      <h2>📲 安装签名描述文件</h2>
      <p>请严格按照顺序操作：</p>
      <ol>
        <li>
          <b>下载并安装 CA 证书</b><br>
          <a href="/ca.crt" style="color:#007AFF;">点击下载 CA 证书</a><br>
          下载后前往 <b>设置 → 通用 → VPN 与设备管理</b> 安装该证书。<br>
          安装后，进入 <b>设置 → 通用 → 关于本机 → 证书信任设置</b>，<br>
          找到 <b>"My Device Info CA"</b>，开启信任开关。
        </li>
        <li style="margin-top:20px;">
          <b>下载并安装描述文件</b><br>
          <a href="/signed-profile.mobileconfig" style="color:#007AFF;">点击下载签名描述文件</a><br>
          下载后前往 <b>设置 → 通用 → VPN 与设备管理</b> 安装。
        </li>
      </ol>
      <p>完成后，数据会自动发送。查看数据：<a href="/devices">/devices</a></p>
    </body>
    </html>
  `);
});

// 下载 CA 证书
app.get('/ca.crt', (req, res) => {
  res.setHeader('Content-Type', 'application/x-x509-ca-cert');
  res.setHeader('Content-Disposition', 'attachment; filename="ca.crt"');
  res.send(caCertPem);
});

// 下载签名后的描述文件
app.get('/signed-profile.mobileconfig', (req, res) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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
  const signed = signMobileconfig(xml);
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="signed-profile.mobileconfig"');
  res.send(Buffer.from(signed, 'binary'));
});

// 原有的接收、结果、查看路由保持不变（略，但与之前相同）
// 这里保持你之前无跳转返回空描述文件的逻辑，因为签名后数据会自动POST
app.post('/receive', async (req, res) => {
  console.log('📥 [接收] POST 请求到达');
  try {
    const deviceInfo = plist.parse(req.body);
    console.log('📋 [解析]', JSON.stringify(deviceInfo));

    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    let geo = { city: '未知', isp: '未知' };
    try {
      const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,isp`, { timeout: 3000 });
      if (geoRes.data.status === 'success') geo = { city: geoRes.data.city, isp: geoRes.data.isp };
    } catch (e) {}

    await pool.query(
      `INSERT INTO devices (udid, version, product, serial, ip, city, isp) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [deviceInfo.UDID||'', deviceInfo.VERSION||'', deviceInfo.PRODUCT||'', deviceInfo.SERIAL||'', ip, geo.city, geo.isp]
    );
    console.log('✅ [入库] UDID:', deviceInfo.UDID);
    // 返回空描述文件，不跳转
    res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>PayloadContent</key><array/></dict></plist>`);
  } catch (err) {
    console.error('❌ 处理失败:', err);
    res.status(500).end();
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

initAll().then(() => {
  app.listen(PORT, () => console.log(`✅ 服务运行在端口 ${PORT}`));
});
