import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000; // Render will provide this

app.use(cors());
app.use(express.json());

// This is the "Secret Key" for your Android App
const ADMIN_KEY = process.env.ADMIN_APP_KEY; 

// ENDPOINT 1: Real Activity Feed (For Tab 1 & 4)
app.get('/api/intel', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    // Logic to pull logs from your bot's database
    res.json([{ protocol: "SYSTEM", subject: "Bridge Active", timestamp: Date.now() }]);
});

// ENDPOINT 2: Survivor List (For Tab 3 Search)
app.get('/api/survivors', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    // Logic to pull survivors from your bot's database
    res.json([]); 
});

app.listen(PORT, () => {
    console.log(`ArkSentinel Mobile Bridge is running on port ${PORT}`);
});
