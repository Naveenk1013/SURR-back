require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MusicBrainzApi } = require('musicbrainz-api');
const { Client: LrcClient } = require('lrclib-api');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Google Drive setup
async function getDriveClient() {
  try {
    // Read credentials and tokens from environment variables
    const credentials = JSON.parse(process.env.CLIENT_SECRET_JSON);
    console.log('Credentials loaded:', credentials.web.client_id);

    if (!credentials.web || !credentials.web.client_id || !credentials.web.client_secret) {
      throw new Error('Invalid CLIENT_SECRET_JSON format');
    }
    const { client_id, client_secret, redirect_uris } = credentials.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const tokens = JSON.parse(process.env.TOKEN_JSON);
    console.log('Tokens loaded:', Object.keys(tokens));
    if (!tokens.access_token) throw new Error('Invalid TOKEN_JSON: missing access_token');
    oauth2Client.setCredentials(tokens);

    return google.drive({ version: 'v3', auth: oauth2Client });
  } catch (err) {
    console.error('Error setting up Drive client:', err.message);
    throw err;
  }
}

// Helper functions
function readJSON(file) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, '[]');
      return [];
    }
    const content = fs.readFileSync(file, 'utf-8').trim();
    if (!content) {
      fs.writeFileSync(file, '[]');
      return [];
    }
    return JSON.parse(content);
  } catch (err) {
    console.error(`Invalid JSON in ${file}, resetting...`);
    fs.writeFileSync(file, '[]');
    return [];
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const SONGS_FILE = path.join(__dirname, 'songs.json');
const PLAYLISTS_FILE = path.join(__dirname, 'playlists.json');

// Multer setup for temporary uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage });

// MusicBrainz API setup
const mbApi = new MusicBrainzApi({
  appName: 'private-music-app',
  appVersion: '1.0.0',
  appContactInfo: 'naveen@example.com' // Replace with your actual email
});

// LRCLIB API setup
const lrcClient = new LrcClient();

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'music-test.html'));
});

// Upload a song
app.post('/upload', upload.single('song'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const songPath = path.join(UPLOAD_DIR, req.file.filename);
  let drive;
  try {
    drive = await getDriveClient();
  } catch (err) {
    console.error('Failed to initialize Drive client:', err.message);
    await fsPromises.unlink(songPath).catch(err => console.error('Failed to delete temp file:', err));
    return res.status(500).json({ error: 'Failed to initialize Google Drive' });
  }

  // Step 1: Extract metadata using music-metadata
  let metadata = {};
  let common = {};
  try {
    const mm = await import('music-metadata');
    metadata = await mm.parseFile(songPath);
    common = metadata.common || {};
    console.log('music-metadata result:', common, 'Duration:', metadata.format?.duration);
  } catch (err) {
    console.error('Metadata extraction failed:', err.message);
  }

  // Prepare basic song data
  let title = common.title || req.file.originalname.replace(path.extname(req.file.originalname), '');
  let artist = common.artist || 'Unknown';
  let album = common.album || 'Unknown';
  let genre = common.genre ? common.genre[0] : 'Unknown';
  let duration = metadata.format?.duration || 0;

  // Step 2: Upload to Google Drive
  let driveFileId = null;
  try {
    const fileMetadata = {
      name: req.file.filename,
      mimeType: req.file.mimetype
    };
    const media = {
      mimeType: req.file.mimetype,
      body: fs.createReadStream(songPath)
    };
    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id'
    });
    driveFileId = driveResponse.data.id;
    console.log('Uploaded to Drive, file ID:', driveFileId);

    // Make file accessible for streaming
    await drive.permissions.create({
      fileId: driveFileId,
      requestBody: {
        role: 'reader',
        type: 'anyone'
      }
    });
  } catch (err) {
    console.error('Drive upload failed:', err.message);
    await fsPromises.unlink(songPath).catch(err => console.error('Failed to delete temp file:', err));
    return res.status(500).json({ error: 'Failed to upload to Google Drive' });
  }

  // Clean up temporary file
  await fsPromises.unlink(songPath).catch(err => console.error('Failed to delete temp file:', err));

  // Step 3: Fetch additional metadata if title and artist are known
  let albumArt = null;
  let lyrics = null;
  if (title && artist !== 'Unknown') {
    try {
      // MusicBrainz: Search for recording
      const searchQuery = `recording:"${title}" AND artist:"${artist}"`;
      const searchResult = await mbApi.search('recording', { query: searchQuery });
      if (searchResult.recordings && searchResult.recordings.length > 0) {
        const recording = searchResult.recordings[0];
        const recordingMbid = recording.id;

        // Lookup recording to get releases
        const lookupResult = await mbApi.lookup('recording', recordingMbid, { inc: 'releases+genres' });
        if (lookupResult.releases && lookupResult.releases.length > 0) {
          const releaseMbid = lookupResult.releases[0].id;
          // Album art URL from Cover Art Archive
          albumArt = `https://coverartarchive.org/release/${releaseMbid}/front-500`;
        }

        // Refine genre if available
        if (lookupResult.genres && lookupResult.genres.length > 0) {
          genre = lookupResult.genres[0].name;
        }
      }
    } catch (err) {
      console.error('MusicBrainz API error:', err.message);
    }

    try {
      // LRCLIB: Fetch lyrics
      const lrcQuery = { track_name: title, artist_name: artist };
      const lrcResult = await lrcClient.getUnsynced(lrcQuery);
      if (lrcResult) {
        lyrics = lrcResult.plainLyrics;
      }
    } catch (err) {
      console.error('LRCLIB API error:', err.message);
    }
  }

  // Step 4: Save song
  const songs = readJSON(SONGS_FILE);
  const newSong = {
    id: uuidv4(),
    title,
    artist,
    album,
    genre,
    duration,
    albumArt,
    lyrics,
    driveFileId,
    createdAt: new Date()
  };
  console.log('Saving song:', newSong);
  songs.push(newSong);
  writeJSON(SONGS_FILE, songs);
  res.json(newSong);
});

// Get all songs
app.get('/songs', (req, res) => {
  const songs = readJSON(SONGS_FILE);
  res.json(songs);
});

// Stream song by ID
app.get('/stream/:id', async (req, res) => {
  const songs = readJSON(SONGS_FILE);
  const song = songs.find(s => s.id === req.params.id);
  if (!song) {
    console.error(`Song not found for ID: ${req.params.id}`);
    return res.status(404).json({ error: 'Song not found' });
  }

  if (!song.driveFileId) {
    console.error(`No Drive file ID for song: ${song.title}`);
    return res.status(404).json({ error: 'Audio file not found' });
  }

  let drive;
  try {
    drive = await getDriveClient();
  } catch (err) {
    console.error('Failed to initialize Drive client:', err.message);
    return res.status(500).json({ error: 'Failed to initialize Google Drive' });
  }

  try {
    const response = await drive.files.get(
      { fileId: song.driveFileId, alt: 'media' },
      { responseType: 'stream' }
    );
    res.set({
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes'
    });
    response.data.pipe(res);
  } catch (err) {
    console.error('Drive streaming error:', err.message);
    res.status(500).json({ error: 'Failed to stream audio' });
  }
});

// Search songs
app.get('/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  const songs = readJSON(SONGS_FILE);
  const results = songs.filter(s => s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q));
  res.json(results);
});

// Get playlists
app.get('/playlist', (req, res) => {
  const playlists = readJSON(PLAYLISTS_FILE);
  res.json(playlists);
});

// Create playlist
app.post('/playlist', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Playlist name required' });

  const playlists = readJSON(PLAYLISTS_FILE);
  const newPlaylist = { id: uuidv4(), name, songs: [] };
  playlists.push(newPlaylist);
  writeJSON(PLAYLISTS_FILE, playlists);
  res.json(newPlaylist);
});

// Add song to playlist
app.put('/playlist/:id/add', (req, res) => {
  const { songId } = req.body;
  const playlists = readJSON(PLAYLISTS_FILE);
  const playlist = playlists.find(p => p.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });

  const songs = readJSON(SONGS_FILE);
  const song = songs.find(s => s.id === songId);
  if (!song) return res.status(404).json({ error: 'Song not found' });

  if (!playlist.songs.includes(song)) playlist.songs.push(song);
  writeJSON(PLAYLISTS_FILE, playlists);
  res.json(playlist);
});

// Get songs of a playlist
app.get('/playlist/:id', (req, res) => {
  const playlists = readJSON(PLAYLISTS_FILE);
  const playlist = playlists.find(p => p.id === req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  res.json(playlist);
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
