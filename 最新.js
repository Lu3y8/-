const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.text({ type: '*/*' }));
app.use(express.static('.'));

const devices = [];

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
        res.redirect(301, '/success.html');
    } catch (error) {
        console.error('❌ 失败:', error);
        res.redirect(301, '/error.html');
    }
});

app.get('/devices', (req, res) => {
    res.json(devices);
});

app.listen(PORT, () => {
    console.log(`✅ 服务运行在端口 ${PORT}`);
    console.log(`📱 配置下载地址: https://localhost:${PORT}/device-info.mobileconfig`);
});