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
import { getUserChannels, addChannel, removeChannel, syncChannel } from "../controllers/channelsController";
import { getSongs } from "../controllers/songsController";
import { getFavorites, toggleFavorite } from "../controllers/favoritesController";
import {
  getPlaylists, createPlaylist, deletePlaylist,
  getPlaylistSongs, addSongToPlaylist, removeSongFromPlaylist,
} from "../controllers/playlistsController";
import { streamSong, streamByToken } from "../controllers/streamController";
import { getUserDownloads, startDownload, deleteDownload } from "../controllers/downloadsController";
import { getProxy, setProxy, testProxy } from "../controllers/proxyController";

const router = Router();

// ── Auth ────────────────────────────────────────────────────────
router.post("/auth/register", registerValidation, register);
router.post("/auth/login", loginValidation, login);
router.post("/auth/refresh", refreshToken);
router.get("/auth/me", authenticate, getMe);
router.put("/auth/profile", authenticate, updateProfileValidation, updateProfile);
router.put("/auth/password", authenticate, updatePasswordValidation, updatePassword);
router.post("/auth/logout", authenticate, logout);

// ── Channels ────────────────────────────────────────────────────
router.get("/channels", authenticate, getUserChannels);
router.post("/channels", authenticate, addChannel);
router.delete("/channels/:id", authenticate, removeChannel);
router.post("/channels/:id/sync", authenticate, syncChannel);

// ── Songs ───────────────────────────────────────────────────────
router.get("/songs", authenticate, getSongs);

// ── Favorites ───────────────────────────────────────────────────
router.get("/favorites", authenticate, getFavorites);
router.post("/favorites/toggle", authenticate, toggleFavorite);

// ── Playlists ───────────────────────────────────────────────────
router.get("/playlists", authenticate, getPlaylists);
router.post("/playlists", authenticate, createPlaylist);
router.delete("/playlists/:id", authenticate, deletePlaylist);
router.get("/playlists/:id/songs", authenticate, getPlaylistSongs);
router.post("/playlists/:id/songs", authenticate, addSongToPlaylist);
router.delete("/playlists/:id/songs/:songId", authenticate, removeSongFromPlaylist);

// ── Stream ──────────────────────────────────────────────────────
router.post("/stream", authenticate, streamSong);
router.get("/stream/:token", streamByToken); // بدون auth - token خودش امنیت داره

// ── Downloads ───────────────────────────────────────────────────
router.get("/downloads", authenticate, getUserDownloads);
router.post("/downloads/start", authenticate, startDownload);
router.delete("/downloads/:id", authenticate, deleteDownload);

// ── Proxy ───────────────────────────────────────────────────────
router.get("/proxy", authenticate, getProxy);
router.post("/proxy", authenticate, setProxy);
router.post("/proxy/test", authenticate, testProxy);

export default router;
