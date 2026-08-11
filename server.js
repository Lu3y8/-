const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.text({ type: '*/*' }));

// 静态文件 MIME 处理
app.use((req, res, next) => {
    if (req.path.endsWith('.mobileconfig')) {
        res.setHeader('Content-Type', 'application/x-apple-aspen-config');
        res.setHeader('Content-Disposition', 'attachment; filename="device.mobileconfig"');
    }
    next();
});

// 托管当前目录（提供 .mobileconfig 下载）
app.use(express.static('.'));

// 内存存储
const devices = [];

// 返回一个空的有效描述文件（让设备安装成功但没有任何实际配置）
function getEmptyProfile() {
    const emptyProfile = `<?xml version="1.0" encoding="UTF-8"?>
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
    <string>$(uuidgen)</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadType</key>
    <string>Configuration</string>
</dict>
</plist>`;
    // 动态生成一个随机 UUID，避免重复
    const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
    return emptyProfile.replace('$(uuidgen)', uuid);
}

// 接收设备 POST 的数据
app.post('/receive', async (req, res) => {
    try {
        const rawBody = req.body;
        const deviceInfo = plist.parse(rawBody);

        // 提取 IP
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
        if (ip.includes(',')) ip = ip.split(',')[0].trim();
        if (ip.startsWith('::ffff:')) ip = ip.slice(7);

        // 可选：IP 归属地
        let geo = { city: '未知', isp: '未知' };
        try {
            const geoRes = await axios.get(`http://ip-api.com/json/${ip}?fields=status,city,isp`, { timeout: 3000 });
            if (geoRes.data.status === 'success') {
                geo = { city: geoRes.data.city, isp: geoRes.data.isp };
            }
        } catch (e) {}

        const fullInfo = {
            ...deviceInfo,
            ip,
            city: geo.city,
            isp: geo.isp,
            receivedAt: new Date().toISOString()
        };

        devices.push(fullInfo);
        console.log('✅ 收到设备:', JSON.stringify(fullInfo, null, 2));

        // 🔥 关键修改：返回一个空的有效描述文件，不跳转
        const emptyXML = getEmptyProfile();
        res.setHeader('Content-Type', 'application/x-apple-aspen-config');
        res.send(emptyXML);
    } catch (error) {
        console.error('❌ 处理失败:', error);
        // 即使失败也返回一个空描述文件，避免用户看到错误
        res.setHeader('Content-Type', 'application/x-apple-aspen-config');
        res.send(getEmptyProfile());
    }
});

// 查看已收集的设备（你后台用）
app.get('/devices', (req, res) => {
    res.json(devices);
});

// 启动
app.listen(PORT, () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
    console.log(`📱 配置下载地址: http://localhost:${PORT}/你的配置文件名.mobileconfig`);
});
