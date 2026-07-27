const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const config = require("../config.json");
const { t } = require("./lib/text");

function ensureDataDirectory() {
	const dataDir = path.join(__dirname, "..", "data");
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
		console.log(t("system.createdDataDirectory"));
	}
}

function createDatabase() {
	ensureDataDirectory();

	const dbPath = path.resolve(__dirname, "..", config.database.path || "data/hunt.db");
	const db = new Database(dbPath);

	// optimize performance
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");

	console.log(t("system.dbInitialized"));

	db.exec(`
		CREATE TABLE IF NOT EXISTS teams (
			team_id TEXT PRIMARY KEY,
			channel_id TEXT UNIQUE,
			team_name TEXT,
			level INTEGER DEFAULT 1,
			points INTEGER DEFAULT 0,
			hint_used TEXT DEFAULT '[]',
			start_time INTEGER,
			created_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS team_members (
			team_id TEXT,
			user_id TEXT,
			username TEXT,
			joined_at INTEGER,
			PRIMARY KEY (team_id, user_id),
			FOREIGN KEY(team_id) REFERENCES teams(team_id)
		);

		CREATE TABLE IF NOT EXISTS team_completed_levels (
			team_id TEXT,
			level_id INTEGER,
			completed_at INTEGER,
			points_earned INTEGER,
			completed_by TEXT,
			FOREIGN KEY(team_id) REFERENCES teams(team_id)
		);

		CREATE TABLE IF NOT EXISTS team_attempts (
			attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
			team_id TEXT,
			user_id TEXT,
			username TEXT,
			level_id INTEGER,
			answer TEXT,
			is_correct BOOLEAN,
			attempted_at INTEGER,
			FOREIGN KEY(team_id) REFERENCES teams(team_id)
		);

		CREATE TABLE IF NOT EXISTS first_blood (
			level_id INTEGER PRIMARY KEY,
			team_id TEXT,
			team_name TEXT,
			completed_by TEXT,
			completed_at INTEGER,
			FOREIGN KEY(team_id) REFERENCES teams(team_id)
		);
	`);

	console.log(t("system.tablesVerified"));
	return db;
}

function createDatabaseHelpers(db) {
	function createTeam(channelId, teamName, creatorId, creatorUsername) {
		const teamId = `team_${channelId}`;
		const now = Date.now();

		const transaction = db.transaction(() => {
			const teamStmt = db.prepare(
				"INSERT INTO teams (team_id, channel_id, team_name, start_time, created_at) VALUES (?, ?, ?, ?, ?)",
			);
			teamStmt.run(teamId, channelId, teamName, now, now);

			const memberStmt = db.prepare(
				"INSERT INTO team_members (team_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)",
			);
			memberStmt.run(teamId, creatorId, creatorUsername, now);
		});

		transaction();
		return teamId;
	}

	function getTeamByChannel(channelId) {
		const stmt = db.prepare("SELECT * FROM teams WHERE channel_id = ?");
		const row = stmt.get(channelId);

		if (row) {
			row.hintUsed = JSON.parse(row.hint_used || "[]");
		}
		return row;
	}

	function getTeamMembers(teamId) {
		const stmt = db.prepare(
			"SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at",
		);
		return stmt.all(teamId) || [];
	}

	function addTeamMember(teamId, userId, username) {
		const stmt = db.prepare(
			"INSERT INTO team_members (team_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)",
		);
		stmt.run(teamId, userId, username, Date.now());
	}

	function updateTeamProgress(teamId, data) {
		const stmt = db.prepare(
			"UPDATE teams SET level = ?, points = ?, hint_used = ? WHERE team_id = ?",
		);
		stmt.run(data.level, data.points, JSON.stringify(data.hintUsed), teamId);
	}

	function updateTeamPoints(teamId, points) {
		const stmt = db.prepare("UPDATE teams SET points = ? WHERE team_id = ?");
		stmt.run(points, teamId);
	}

	function recordTeamAttempt(
		teamId,
		userId,
		username,
		levelId,
		answer,
		isCorrect,
	) {
		const stmt = db.prepare(
			"INSERT INTO team_attempts (team_id, user_id, username, level_id, answer, is_correct, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		stmt.run(
			teamId,
			userId,
			username,
			levelId,
			answer,
			isCorrect ? 1 : 0,
			Date.now(),
		);
	}

	function getTeamLeaderboard() {
		const stmt = db.prepare(`
			SELECT t.*, 
			(SELECT COUNT(*) FROM team_members WHERE team_id = t.team_id) as member_count,
			(SELECT MAX(completed_at) FROM team_completed_levels WHERE team_id = t.team_id) as last_completed
			FROM teams t 
			ORDER BY t.points DESC, last_completed ASC LIMIT 10
		`);
		return stmt.all() || [];
	}

	function getAllTeamsProgress() {
		const stmt = db.prepare(`
			SELECT t.*, 
			(SELECT COUNT(*) FROM team_members WHERE team_id = t.team_id) as member_count,
			(SELECT MAX(completed_at) FROM team_completed_levels WHERE team_id = t.team_id) as last_completed
			FROM teams t 
			ORDER BY t.points DESC
		`);
		return stmt.all() || [];
	}

	function getRecentAttempts(limit = 20) {
		const stmt = db.prepare(`
			SELECT ta.*, t.team_name, t.channel_id 
			FROM team_attempts ta 
			JOIN teams t ON ta.team_id = t.team_id 
			ORDER BY ta.attempted_at DESC LIMIT ?
		`);
		return stmt.all(limit) || [];
	}

	function getFirstBloodStats() {
		const stmt = db.prepare("SELECT * FROM first_blood ORDER BY level_id ASC");
		return stmt.all() || [];
	}

	function checkFirstBlood(levelId, teamId, teamName, completedBy) {
		const checkStmt = db.prepare("SELECT * FROM first_blood WHERE level_id = ?");
		const existing = checkStmt.get(levelId);

		if (existing) {
			return false;
		}
		const insertStmt = db.prepare(
			"INSERT INTO first_blood (level_id, team_id, team_name, completed_by, completed_at) VALUES (?, ?, ?, ?, ?)",
		);
		insertStmt.run(levelId, teamId, teamName, completedBy, Date.now());
		return true;
	}

	function resetHuntDatabase() {
		const transaction = db.transaction(() => {
			db.exec(`
				DELETE FROM team_attempts;
				DELETE FROM team_completed_levels;
				DELETE FROM first_blood;
				DELETE FROM team_members;
				DELETE FROM teams;
				DELETE FROM sqlite_sequence;
			`);
		});

		transaction();
	}

	return {
		createTeam,
		getTeamByChannel,
		getTeamMembers,
		addTeamMember,
		updateTeamProgress,
		updateTeamPoints,
		recordTeamAttempt,
		getTeamLeaderboard,
		getAllTeamsProgress,
		getRecentAttempts,
		getFirstBloodStats,
		checkFirstBlood,
		resetHuntDatabase,
	};
}

module.exports = {
	createDatabase,
	createDatabaseHelpers,
};