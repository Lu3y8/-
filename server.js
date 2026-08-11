const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.text({ type: '*/*' }));

// 为 .mobileconfig 文件设置正确的 MIME 类型
app.use((req, res, next) => {
    if (req.path.endsWith('.mobileconfig')) {
        res.setHeader('Content-Type', 'application/x-apple-aspen-config');
        res.setHeader('Content-Disposition', 'attachment; filename="device.mobileconfig"');
    }
    next();
});

// 托管静态文件（使 .mobileconfig 可通过域名直接访问）
app.use(express.static('.'));

// 存储收到的设备信息（内存中）
const devices = [];

// 接收设备信息的接口
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

        const fullInfo = {
            ...deviceInfo,
            ip: ip,
            city: geo.city,
            isp: geo.isp,
            receivedAt: new Date().toISOString()
        };

        devices.push(fullInfo);
        console.log('✅ 收到设备:', JSON.stringify(fullInfo, null, 2));
        res.send('✅ 设备信息已收到，请关闭此页面');
    } catch (error) {
        console.error('❌ 处理失败:', error);
        res.send('❌ 接收失败，请重试');
    }
});

// 查看所有已收集设备信息的接口
app.get('/devices', (req, res) => {
    res.json(devices);
});

// 启动服务
app.listen(PORT, () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
    console.log(`📱 配置下载地址: https://localhost:${PORT}/最新配置文件.mobileconfig`);
});
