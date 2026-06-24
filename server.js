import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { createHash } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const db = createClient({
  url: 'libsql://cherryme2-angelo67.aws-eu-west-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJnaWQiOiIxYjY4YWMxOC1kZmRkLTQ1OTYtOGNhMy03ZGViYzViMzU3MGIiLCJpYXQiOjE3ODIzNDMzMDYsInJpZCI6IjNiOTU2MTEyLThlMDAtNDc4OS1iNThjLTNjZjcxNjVkMmY2MSJ9.xyf-60LyYKlSpDQyj28kRwFP4FSwGjEI6HJtSP2a9JxpBqGfybZtge1AjDr7BU6tcTzB9O-zS6S0JRvng862Bg',
});

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

// --- AUTH ---
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = hashPassword(password);
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, bio, tokens FROM users WHERE username = ? AND password_hash = ?',
      args: [username, hash],
    });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub hasło' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, bio, tokens FROM users WHERE id = ?',
      args: [req.params.id],
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const q = req.query.q || '';
    const result = await db.execute({
      sql: "SELECT id, username, display_name, role, avatar_url, bio FROM users WHERE display_name LIKE ? OR username LIKE ?",
      args: [`%${q}%`, `%${q}%`],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POSTS ---
app.get('/api/posts', async (req, res) => {
  try {
    const result = await db.execute(
      `SELECT p.*, u.display_name, u.username, u.avatar_url, u.role,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       ORDER BY p.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const { user_id, content, image_url, is_premium } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO posts (user_id, content, image_url, is_premium) VALUES (?, ?, ?, ?) RETURNING *',
      args: [user_id, content, image_url || '', is_premium || 0],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LIKES ---
app.post('/api/likes', async (req, res) => {
  try {
    const { user_id, post_id } = req.body;
    await db.execute({ sql: 'INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)', args: [user_id, post_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/likes', async (req, res) => {
  try {
    const { user_id, post_id } = req.body;
    await db.execute({ sql: 'DELETE FROM likes WHERE user_id = ? AND post_id = ?', args: [user_id, post_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- COMMENTS ---
app.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT c.*, u.display_name, u.username, u.avatar_url
            FROM comments c JOIN users u ON c.user_id = u.id
            WHERE c.post_id = ? ORDER BY c.created_at ASC`,
      args: [req.params.id],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/comments', async (req, res) => {
  try {
    const { user_id, content, tip_amount } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO comments (post_id, user_id, content, tip_amount) VALUES (?, ?, ?, ?) RETURNING *',
      args: [req.params.id, user_id, content, tip_amount || 0],
    });
    if (tip_amount > 0) {
      await db.execute({ sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ?', args: [tip_amount, user_id] });
      const post = await db.execute({ sql: 'SELECT user_id FROM posts WHERE id = ?', args: [req.params.id] });
      if (post.rows.length > 0) {
        await db.execute({ sql: 'UPDATE users SET tokens = tokens + ? WHERE id = ?', args: [tip_amount, post.rows[0].user_id] });
      }
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MESSAGES ---
app.get('/api/messages/conversations/:userId', async (req, res) => {
  try {
    const uid = req.params.userId;
    const result = await db.execute({
      sql: `SELECT u.id, u.display_name, u.username, u.avatar_url, u.role,
              (SELECT content FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_message,
              (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread
            FROM users u
            WHERE u.id != ? AND (
              u.id IN (SELECT sender_id FROM messages WHERE receiver_id = ?)
              OR u.id IN (SELECT receiver_id FROM messages WHERE sender_id = ?)
            )`,
      args: [uid, uid, uid, uid, uid, uid],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:userId/:otherId', async (req, res) => {
  try {
    const { userId, otherId } = req.params;
    const result = await db.execute({
      sql: `SELECT * FROM messages
            WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
            ORDER BY created_at ASC`,
      args: [userId, otherId, otherId, userId],
    });
    await db.execute({
      sql: 'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      args: [otherId, userId],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', async (req, res) => {
  try {
    const { sender_id, receiver_id, content, tip_amount } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO messages (sender_id, receiver_id, content, tip_amount) VALUES (?, ?, ?, ?) RETURNING *',
      args: [sender_id, receiver_id, content, tip_amount || 0],
    });
    if (tip_amount > 0) {
      await db.execute({ sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ?', args: [tip_amount, sender_id] });
      await db.execute({ sql: 'UPDATE users SET tokens = tokens + ? WHERE id = ?', args: [tip_amount, receiver_id] });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FOLLOWS ---
app.post('/api/follows', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    await db.execute({ sql: 'INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)', args: [follower_id, following_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/follows', async (req, res) => {
  try {
    const { follower_id, following_id } = req.body;
    await db.execute({ sql: 'DELETE FROM follows WHERE follower_id = ? AND following_id = ?', args: [follower_id, following_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
