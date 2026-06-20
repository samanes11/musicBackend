import { Router } from "express";
import {
  register, login, getMe, updateProfile,
  updatePassword, logout, refreshToken,
} from "../controllers/authController";
import {
  registerValidation, loginValidation,
  updatePasswordValidation, updateProfileValidation,
} from "../middleware/validators";
import { authenticate } from "../middleware/auth";
import {
  getUserChannels, addChannel, removeChannel,
  syncChannel, getSyncStatus,
} from "../controllers/channelsController";
import { getSongById, getSongs } from "../controllers/songsController";
import { getFavorites, toggleFavorite } from "../controllers/favoritesController";
import {
  getPlaylists, createPlaylist, deletePlaylist,
  getPlaylistSongs, addSongToPlaylist, removeSongFromPlaylist,
} from "../controllers/playlistsController";
import {
  streamSong, streamByToken, checkDiskCache,
  issueStreamToken, getCacheStats,
} from "../controllers/streamController";
import { checkServerCache } from "../controllers/downloadsController";
import { getProxy, setProxy, testProxy } from "../controllers/proxyController";
import { adminAuth } from "../middleware/adminAuth";
import {
  listDefaultChannels,
  applyDefaultChannelsToAllUsers,
} from "../controllers/defaultChannelsController";
import {
  startForwarder,
  getForwarderStatus,
  cancelForwarder,
  listForwarderJobs,
} from "../controllers/forwarderController";

const router = Router();

// ── Auth ────────────────────────────────────────────────────────
router.post("/auth/register", registerValidation, register);
router.post("/auth/login",    loginValidation,    login);
router.post("/auth/refresh",  refreshToken);
router.get ("/auth/me",       authenticate, getMe);
router.put ("/auth/profile",  authenticate, updateProfileValidation,  updateProfile);
router.put ("/auth/password", authenticate, updatePasswordValidation, updatePassword);
router.post("/auth/logout",   authenticate, logout);

// ── Admin: Default Channels ─────────────────────────────────────
router.get ("/admin/default-channels",           adminAuth, listDefaultChannels);
router.post("/admin/default-channels/apply-all", adminAuth, applyDefaultChannelsToAllUsers);

// ── Admin: Music Forwarder ──────────────────────────────────────
router.post("/admin/forwarder/start",            adminAuth, startForwarder);
router.get ("/admin/forwarder/jobs",             adminAuth, listForwarderJobs);
router.get ("/admin/forwarder/status/:jobId",    adminAuth, getForwarderStatus);
router.post("/admin/forwarder/cancel/:jobId",    adminAuth, cancelForwarder);

// ── Channels ────────────────────────────────────────────────────
router.get   ("/channels",          authenticate, getUserChannels);
router.post  ("/channels",          authenticate, addChannel);
router.delete("/channels/:id",      authenticate, removeChannel);
router.post  ("/channels/:id/sync", authenticate, syncChannel);
router.get   ("/channels/:id/sync-status", authenticate, getSyncStatus);

// ── Songs ───────────────────────────────────────────────────────
router.get("/songs",     authenticate, getSongs);
router.get("/songs/:id", authenticate, getSongById);

// ── Favorites ───────────────────────────────────────────────────
router.get ("/favorites",        authenticate, getFavorites);
router.post("/favorites/toggle", authenticate, toggleFavorite);

// ── Playlists ───────────────────────────────────────────────────
router.get   ("/playlists",                    authenticate, getPlaylists);
router.post  ("/playlists",                    authenticate, createPlaylist);
router.delete("/playlists/:id",                authenticate, deletePlaylist);
router.get   ("/playlists/:id/songs",          authenticate, getPlaylistSongs);
router.post  ("/playlists/:id/songs",          authenticate, addSongToPlaylist);
router.delete("/playlists/:id/songs/:songId",  authenticate, removeSongFromPlaylist);

// ── Stream ──────────────────────────────────────────────────────
router.get ("/stream/check/:fileId",   authenticate, checkDiskCache);
router.get ("/stream/token/:songId",   authenticate, issueStreamToken);
router.get ("/stream/admin/stats",     authenticate, getCacheStats);
router.post("/stream",                 authenticate, streamSong);
router.get ("/stream/:token",          streamByToken);

// ── Downloads ───────────────────────────────────────────────────
router.get("/downloads/check/:fileId", authenticate, checkServerCache);

// ── Proxy ───────────────────────────────────────────────────────
router.get ("/proxy",      authenticate, getProxy);
router.post("/proxy",      authenticate, setProxy);
router.post("/proxy/test", authenticate, testProxy);

export default router;
