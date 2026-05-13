import express from 'express';
import cors from 'cors';

const app = express();
// IMPORTANT: Render tells us which port to use via process.env.PORT
const PORT = process.env.PORT || 10000; 

app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_APP_KEY;

// Health check for Render
app.get('/', (req, res) => {
    res.send('ArkSentinel API is Online');
});

// Mobile App: Activity Feed
app.get('/api/intel', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    // Add your log logic here
    res.json([]); 
});

// Mobile App: Survivor List
app.get('/api/survivors', (req, res) => {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.sendStatus(403);
    // Add your survivor logic here
    res.json([]);
});

// ONLY ONE .listen() call in the entire project
app.listen(PORT, () => {
    console.log(`ArkSentinel Bridge active on port ${PORT}`);
});
