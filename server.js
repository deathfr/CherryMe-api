import express from 'express';
import cors from 'cors';
import { createClient } from '@libsql/client';
import { createHash } from 'crypto';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const db = createClient({
  url: 'libsql://cherryme2-angelo67.aws-eu-west-1.turso.io',
  authToken: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJnaWQiOiIxYjY4YWMxOC1kZmRkLTQ1OTYtOGNhMy03ZGViYzViMzU3MGIiLCJpYXQiOjE3ODIzNDMzMDYsInJpZCI6IjNiOTU2MTEyLThlMDAtNDc4OS1iNThjLTNjZjcxNjVkMmY2MSJ9.xyf-60LyYKlSpDQyj28kRwFP4FSwGjEI6HJtSP2a9JxpBqGfybZtge1AjDr7BU6tcTzB9O-zS6S0JRvng862Bg',
});

function hashPassword(password) {
  return createHash('sha256').update(password).digest('hex');
}

const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1521145919288901683/feC86rEoQwiwoIWCN0Xji_dgoNpn3sxNpamKMValuekOPH4TkQoD-vwt82lnVjyo-LD7';

async function notifyDiscord(content) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
  } catch (err) {
    console.error('Discord webhook failed:', err.message);
  }
}

async function getDisplayName(userId) {
  try {
    const r = await db.execute({ sql: 'SELECT display_name FROM users WHERE id = ?', args: [userId] });
    return r.rows[0]?.display_name || 'Ktoś';
  } catch {
    return 'Ktoś';
  }
}

// --- AUTH ---
app.post('/api/admin/create-user', async (req, res) => {
  try {
    const { admin_id, username, role, tokens, fake_followers, fake_subscribers } = req.body;
    if (parseInt(admin_id) !== 1) return res.status(403).json({ error: 'Not authorized' });
    if (!username?.trim()) return res.status(400).json({ error: 'Username required' });

    const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [username] });
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Username already taken' });

    const hash = hashPassword('123');
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash, display_name, role, tokens, fake_followers, fake_subscribers) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [username, hash, username, role, role === 'user' ? (tokens || 0) : 0, role === 'model' ? (fake_followers || 0) : 0, role === 'model' ? (fake_subscribers || 0) : 0],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const hash = hashPassword(password);
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, banner_url, bio, tokens FROM users WHERE username = ? AND password_hash = ?',
      args: [username, hash],
    });
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, banner_url, bio, tokens FROM users WHERE id = ?',
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

// --- PUBLIC PROFILE ---
app.get('/api/profile/:username', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, banner_url, bio, tokens, fake_followers, fake_subscribers FROM users WHERE username = ?',
      args: [req.params.username],
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = result.rows[0];
    const followers = await db.execute({ sql: 'SELECT COUNT(*) as count FROM follows WHERE following_id = ?', args: [user.id] });
    const following = await db.execute({ sql: 'SELECT COUNT(*) as count FROM follows WHERE follower_id = ?', args: [user.id] });
    const postCount = await db.execute({ sql: 'SELECT COUNT(*) as count FROM posts WHERE user_id = ?', args: [user.id] });
    const subscribers = await db.execute({ sql: "SELECT COUNT(*) as count FROM subscriptions WHERE creator_id = ? AND expires_at > datetime('now')", args: [user.id] });
    res.json({
      ...user,
      followers: followers.rows[0].count + (user.fake_followers || 0),
      following: following.rows[0].count,
      post_count: postCount.rows[0].count,
      subscribers: subscribers.rows[0].count + (user.fake_subscribers || 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/profile/:username/posts', async (req, res) => {
  try {
    const user = await db.execute({ sql: 'SELECT id FROM users WHERE username = ?', args: [req.params.username] });
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const result = await db.execute({
      sql: `SELECT p.*, u.display_name, u.username, u.avatar_url, u.role,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ? ORDER BY p.created_at DESC`,
      args: [user.rows[0].id],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/follows/check/:followerId/:followingId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM follows WHERE follower_id = ? AND following_id = ?',
      args: [req.params.followerId, req.params.followingId],
    });
    res.json({ following: result.rows[0].count > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- UPDATE PROFILE ---
app.put('/api/users/:id', async (req, res) => {
  try {
    const { username, display_name, avatar_url } = req.body;
    if (username) {
      const existing = await db.execute({ sql: 'SELECT id FROM users WHERE username = ? AND id != ?', args: [username, req.params.id] });
      if (existing.rows.length > 0) return res.status(400).json({ error: 'This username is already taken' });
    }
    const fields = [];
    const args = [];
    if (username) { fields.push('username = ?'); args.push(username); }
    if (display_name) { fields.push('display_name = ?'); args.push(display_name); }
    if (avatar_url !== undefined) { fields.push('avatar_url = ?'); args.push(avatar_url); }
    if (req.body.banner_url !== undefined) { fields.push('banner_url = ?'); args.push(req.body.banner_url); }
    if (req.body.bio !== undefined) { fields.push('bio = ?'); args.push(req.body.bio); }
    if (fields.length === 0) return res.status(400).json({ error: 'No data to update' });
    args.push(req.params.id);
    await db.execute({ sql: `UPDATE users SET ${fields.join(', ')} WHERE id = ?`, args });
    const result = await db.execute({
      sql: 'SELECT id, username, display_name, role, avatar_url, banner_url, bio, tokens FROM users WHERE id = ?',
      args: [req.params.id],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/password', async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    const currentHash = hashPassword(current_password);
    const check = await db.execute({ sql: 'SELECT id FROM users WHERE id = ? AND password_hash = ?', args: [req.params.id, currentHash] });
    if (check.rows.length === 0) return res.status(401).json({ error: 'Invalid current password' });
    const newHash = hashPassword(new_password);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [newHash, req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- FOLDERS ---
app.get('/api/folders/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT f.*, (SELECT COUNT(*) FROM gallery WHERE folder_id = f.id) as photo_count,
            (SELECT image_url FROM gallery WHERE folder_id = f.id ORDER BY created_at DESC LIMIT 1) as cover_url
            FROM folders f WHERE f.user_id = ? ORDER BY f.name ASC`,
      args: [req.params.userId],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folders', async (req, res) => {
  try {
    const { user_id, name } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO folders (user_id, name) VALUES (?, ?) RETURNING *',
      args: [user_id, name],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/folders/:id', async (req, res) => {
  try {
    const { name } = req.body;
    await db.execute({ sql: 'UPDATE folders SET name = ? WHERE id = ?', args: [name, req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/folders/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'UPDATE gallery SET folder_id = NULL WHERE folder_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM folders WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/move', async (req, res) => {
  try {
    const { photo_ids, folder_id } = req.body;
    for (const id of photo_ids) {
      await db.execute({ sql: 'UPDATE gallery SET folder_id = ? WHERE id = ?', args: [folder_id, id] });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- GALLERY ---
app.get('/api/gallery/:userId', async (req, res) => {
  try {
    const folderId = req.query.folder;
    let result;
    if (folderId) {
      result = await db.execute({ sql: 'SELECT * FROM gallery WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC', args: [req.params.userId, folderId] });
    } else {
      result = await db.execute({ sql: 'SELECT * FROM gallery WHERE user_id = ? AND folder_id IS NULL ORDER BY created_at DESC', args: [req.params.userId] });
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/gallery/:userId/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await db.execute({
      sql: 'SELECT * FROM gallery WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      args: [req.params.userId, limit],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery', async (req, res) => {
  try {
    const { user_id, image_url, filename } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO gallery (user_id, image_url, filename) VALUES (?, ?, ?) RETURNING *',
      args: [user_id, image_url, filename || ''],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/gallery/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM gallery WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
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

app.get('/api/posts/feed/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT p.*, u.display_name, u.username, u.avatar_url, u.role,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
       ORDER BY p.created_at DESC`,
      args: [req.params.userId],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/my/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT p.*, u.display_name, u.username, u.avatar_url, u.role,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id) as comment_count
       FROM posts p JOIN users u ON p.user_id = u.id
       WHERE p.user_id = ?
       ORDER BY p.created_at DESC`,
      args: [req.params.userId],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts', async (req, res) => {
  try {
    const { user_id, content, image_url, is_premium, coin_price } = req.body;
    const result = await db.execute({
      sql: 'INSERT INTO posts (user_id, content, image_url, is_premium, coin_price) VALUES (?, ?, ?, ?, ?) RETURNING *',
      args: [user_id, content, image_url || '', is_premium || 0, coin_price || 0],
    });
    res.json(result.rows[0]);
    const name = await getDisplayName(user_id);
    notifyDiscord(`📸 **${name}** opublikował post.`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- LIKES ---
app.get('/api/likes/check/:userId/:postId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?',
      args: [req.params.userId, req.params.postId],
    });
    res.json({ liked: result.rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
              (SELECT sender_id FROM messages WHERE (sender_id = u.id AND receiver_id = ?) OR (sender_id = ? AND receiver_id = u.id) ORDER BY created_at DESC LIMIT 1) as last_sender_id,
              (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND is_read = 0) as unread,
              (SELECT COUNT(*) FROM follows WHERE follower_id = u.id AND following_id = ?) as is_follower,
              (SELECT COUNT(*) FROM subscriptions WHERE user_id = u.id AND creator_id = ? AND expires_at > datetime('now')) as is_subscriber
            FROM users u
            WHERE u.id != ? AND (
              u.id IN (SELECT sender_id FROM messages WHERE receiver_id = ?)
              OR u.id IN (SELECT receiver_id FROM messages WHERE sender_id = ?)
            )`,
      args: [uid, uid, uid, uid, uid, uid, uid, uid, uid, uid],
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
    const name = await getDisplayName(receiver_id);
    notifyDiscord(`💬 **${name}** otrzymał wiadomość.`);
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

// --- SUBSCRIPTIONS ---
app.post('/api/subscribe', async (req, res) => {
  try {
    const { user_id, creator_id } = req.body;
    const cost = 500;
    const userCheck = await db.execute({ sql: 'SELECT tokens FROM users WHERE id = ?', args: [user_id] });
    if (userCheck.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    if (userCheck.rows[0].tokens < cost) return res.status(400).json({ error: 'Not enough Cherry Coins' });

    const existing = await db.execute({
      sql: "SELECT id, expires_at FROM subscriptions WHERE user_id = ? AND creator_id = ? AND expires_at > datetime('now')",
      args: [user_id, creator_id],
    });

    const expiresAt = existing.rows.length > 0
      ? `datetime('${existing.rows[0].expires_at}', '+7 days')`
      : "datetime('now', '+7 days')";

    if (existing.rows.length > 0) {
      await db.execute({ sql: `UPDATE subscriptions SET expires_at = ${expiresAt} WHERE id = ?`, args: [existing.rows[0].id] });
    } else {
      await db.execute({ sql: `INSERT INTO subscriptions (user_id, creator_id, expires_at) VALUES (?, ?, ${expiresAt})`, args: [user_id, creator_id] });
    }

    await db.execute({ sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ?', args: [cost, user_id] });
    await db.execute({ sql: 'UPDATE users SET tokens = tokens + ? WHERE id = ?', args: [cost, creator_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/:userId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT s.*, u.display_name, u.username, u.avatar_url, u.role
            FROM subscriptions s JOIN users u ON s.creator_id = u.id
            WHERE s.user_id = ? AND s.expires_at > datetime('now')
            ORDER BY s.expires_at ASC`,
      args: [req.params.userId],
    });
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscriptions/check/:userId/:creatorId', async (req, res) => {
  try {
    const result = await db.execute({
      sql: "SELECT id, expires_at FROM subscriptions WHERE user_id = ? AND creator_id = ? AND expires_at > datetime('now')",
      args: [req.params.userId, req.params.creatorId],
    });
    res.json({ subscribed: result.rows.length > 0, expires_at: result.rows[0]?.expires_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- POST UNLOCKS ---
app.post('/api/posts/:id/unlock', async (req, res) => {
  try {
    const { user_id } = req.body;
    const post = await db.execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [req.params.id] });
    if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    const p = post.rows[0];
    if (p.is_premium !== 2) return res.status(400).json({ error: 'Post is not coin-locked' });

    const already = await db.execute({ sql: 'SELECT 1 FROM post_unlocks WHERE user_id = ? AND post_id = ?', args: [user_id, req.params.id] });
    if (already.rows.length > 0) return res.json({ ok: true });

    const userCheck = await db.execute({ sql: 'SELECT tokens FROM users WHERE id = ?', args: [user_id] });
    if (userCheck.rows[0].tokens < p.coin_price) return res.status(400).json({ error: 'Not enough Cherry Coins' });

    await db.execute({ sql: 'INSERT INTO post_unlocks (user_id, post_id) VALUES (?, ?)', args: [user_id, req.params.id] });
    await db.execute({ sql: 'UPDATE users SET tokens = tokens - ? WHERE id = ?', args: [p.coin_price, user_id] });
    await db.execute({ sql: 'UPDATE users SET tokens = tokens + ? WHERE id = ?', args: [p.coin_price, p.user_id] });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts/:id/access/:userId', async (req, res) => {
  try {
    const post = await db.execute({ sql: 'SELECT * FROM posts WHERE id = ?', args: [req.params.id] });
    if (post.rows.length === 0) return res.status(404).json({ error: 'Post not found' });
    const p = post.rows[0];
    if (p.is_premium === 0 || p.user_id === parseInt(req.params.userId)) return res.json({ access: true });
    if (p.is_premium === 1) {
      const sub = await db.execute({
        sql: "SELECT 1 FROM subscriptions WHERE user_id = ? AND creator_id = ? AND expires_at > datetime('now')",
        args: [req.params.userId, p.user_id],
      });
      return res.json({ access: sub.rows.length > 0, reason: 'subscribers' });
    }
    if (p.is_premium === 2) {
      const unlock = await db.execute({ sql: 'SELECT 1 FROM post_unlocks WHERE user_id = ? AND post_id = ?', args: [req.params.userId, req.params.id] });
      return res.json({ access: unlock.rows.length > 0, reason: 'coins', price: p.coin_price });
    }
    res.json({ access: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
