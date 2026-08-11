const express = require('express');
const axios = require('axios');
const plist = require('plist');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.text({ type: '*/*' }));

// ---------- 关键修复：为 .mobileconfig 设置正确的 Content-Type ----------
app.use((req, res, next) => {
    if (req.path.endsWith('.mobileconfig')) {
        res.setHeader('Content-Type', 'application/x-apple-aspen-config');
        res.setHeader('Content-Disposition', 'attachment; filename="device.mobileconfig"');
    }
    next();
});

// 静态托管（这样即可访问 .mobileconfig 文件）
app.use(express.static('.'));

// 其余代码（/receive, /devices 等）保持不变...
