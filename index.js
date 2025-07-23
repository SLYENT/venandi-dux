const {
	Client,
	GatewayIntentBits,
	Collection,
	EmbedBuilder,
	SlashCommandBuilder,
	PresenceUpdateStatus,
	PermissionFlagsBits,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.json");
const sqlite3 = require("sqlite3").verbose();

// Create a new client instance first
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// Database helper functions
function handleDatabaseError(error) {
	console.error("Database error:", error);
	return null;
}

// Initialize database
const db = new sqlite3.Database(
	path.join(__dirname, "data", "hunt.db"),
	sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
	(err) => {
		if (err) {
			console.error("Database connection error:", err);
			process.exit(1);
		}
		console.log("Connected to database");
	},
);

// Load hunt data
let huntData;
try {
	huntData = require("./hunt.json");
} catch (error) {
	console.error("Error loading hunt data:", error);
	process.exit(1);
}

// Create tables if they don't exist
db.serialize(() => {
	db.run(`CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY,
        channel_id TEXT UNIQUE,
        team_name TEXT,
        level INTEGER DEFAULT 1,
        points INTEGER DEFAULT 0,
        hint_used TEXT DEFAULT '[]',
        start_time INTEGER,
        created_at INTEGER
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT,
        user_id TEXT,
        username TEXT,
        joined_at INTEGER,
        PRIMARY KEY (team_id, user_id),
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS team_completed_levels (
        team_id TEXT,
        level_id INTEGER,
        completed_at INTEGER,
        points_earned INTEGER,
        completed_by TEXT,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS team_attempts (
        attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT,
        user_id TEXT,
        username TEXT,
        level_id INTEGER,
        answer TEXT,
        is_correct BOOLEAN,
        attempted_at INTEGER,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS first_blood (
        level_id INTEGER PRIMARY KEY,
        team_id TEXT,
        team_name TEXT,
        completed_by TEXT,
        completed_at INTEGER,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

	// Keep existing tables for backward compatibility
	db.run(`CREATE TABLE IF NOT EXISTS user_progress (
        user_id TEXT PRIMARY KEY,
        level INTEGER,
        points INTEGER,
        hint_used TEXT,
        start_time INTEGER
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS completed_levels (
        user_id TEXT,
        level_id INTEGER,
        completed_at INTEGER,
        points_earned INTEGER,
        FOREIGN KEY(user_id) REFERENCES user_progress(user_id)
    )`);

	db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        points INTEGER,
        level INTEGER,
        start_time INTEGER,
        last_completed INTEGER,
        FOREIGN KEY(user_id) REFERENCES user_progress(user_id)
    )`);
});

// Replace userProgress.get with database query
async function getUserProgress(userId) {
	return new Promise((resolve, reject) => {
		db.get(
			"SELECT * FROM user_progress WHERE user_id = ?",
			[userId],
			async (err, row) => {
				if (err) reject(err);
				if (!row) {
					// Initialize new user
					const newUser = {
						level: 1,
						points: 0,
						hintUsed: [],
						startTime: Date.now(),
					};
					await initializeUser(userId, newUser);
					resolve(newUser);
				} else {
					row.hintUsed = JSON.parse(row.hint_used || "[]");
					resolve(row);
				}
			},
		);
	});
}

// Initialize new user
async function initializeUser(userId, data) {
	return new Promise((resolve, reject) => {
		db.run(
			"INSERT INTO user_progress (user_id, level, points, hint_used, start_time) VALUES (?, ?, ?, ?, ?)",
			[
				userId,
				data.level,
				data.points,
				JSON.stringify(data.hintUsed),
				data.startTime,
			],
			(err) => {
				if (err) reject(err);
				resolve();
			},
		);
	});
}

// Update user progress
async function updateUserProgress(userId, data) {
	return new Promise((resolve, reject) => {
		db.run(
			"UPDATE user_progress SET level = ?, points = ?, hint_used = ? WHERE user_id = ?",
			[data.level, data.points, JSON.stringify(data.hintUsed), userId],
			(err) => {
				if (err) reject(err);
				resolve();
			},
		);
	});
}

// Get leaderboard
async function getLeaderboard() {
	return new Promise((resolve, reject) => {
		db.all(
			"SELECT * FROM leaderboard ORDER BY points DESC, last_completed ASC LIMIT 10",
			[],
			(err, rows) => {
				if (err) reject(err);
				resolve(rows || []);
			},
		);
	});
}

// Update leaderboard entry
async function updateLeaderboard(data) {
	return new Promise((resolve, reject) => {
		db.run(
			`INSERT INTO leaderboard (user_id, username, points, level, start_time, last_completed)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET 
             points = ?, level = ?, last_completed = ?`,
			[
				data.userId,
				data.username,
				data.points,
				data.level,
				data.startTime,
				data.lastCompleted,
				data.points,
				data.level,
				data.lastCompleted,
			],
			(err) => {
				if (err) reject(err);
				resolve();
			},
		);
	});
}

// Add getUserRank function
async function getUserRank(userId) {
	return new Promise((resolve, reject) => {
		db.get(
			`SELECT COUNT(*) + 1 as rank FROM leaderboard 
             WHERE points > (SELECT points FROM leaderboard WHERE user_id = ?)`,
			[userId],
			(err, row) => {
				if (err) {
					console.error("Error getting user rank:", err);
					resolve(null);
					return;
				}
				resolve(row ? row.rank : null);
			},
		);
	});
}

// Add completed levels tracking
async function getCompletedLevels(userId) {
	return new Promise((resolve, reject) => {
		db.all(
			"SELECT * FROM completed_levels WHERE user_id = ? ORDER BY completed_at ASC",
			[userId],
			(err, rows) => {
				if (err) {
					console.error("Error getting completed levels:", err);
					resolve([]);
					return;
				}
				resolve(rows || []);
			},
		);
	});
}

// Add completed level recording
async function recordCompletedLevel(
	userId,
	levelId,
	completedAt,
	pointsEarned,
) {
	return new Promise((resolve, reject) => {
		db.run(
			"INSERT INTO completed_levels (user_id, level_id, completed_at, points_earned) VALUES (?, ?, ?, ?)",
			[userId, levelId, completedAt, pointsEarned],
			(err) => {
				if (err) {
					console.error("Error recording completed level:", err);
					resolve(false);
					return;
				}
				resolve(true);
			},
		);
	});
}

// Team management functions
async function createTeam(channelId, teamName, creatorId, creatorUsername) {
	return new Promise((resolve, reject) => {
		const teamId = `team_${channelId}`;
		const now = Date.now();

		db.run(
			"INSERT INTO teams (team_id, channel_id, team_name, start_time, created_at) VALUES (?, ?, ?, ?, ?)",
			[teamId, channelId, teamName, now, now],
			(err) => {
				if (err) {
					reject(err);
					return;
				}

				// Add creator as first member
				db.run(
					"INSERT INTO team_members (team_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)",
					[teamId, creatorId, creatorUsername, now],
					(err) => {
						if (err) reject(err);
						else resolve(teamId);
					},
				);
			},
		);
	});
}

async function getTeamByChannel(channelId) {
	return new Promise((resolve, reject) => {
		db.get(
			"SELECT * FROM teams WHERE channel_id = ?",
			[channelId],
			(err, row) => {
				if (err) reject(err);
				else {
					if (row) {
						row.hintUsed = JSON.parse(row.hint_used || "[]");
					}
					resolve(row);
				}
			},
		);
	});
}

async function getTeamMembers(teamId) {
	return new Promise((resolve, reject) => {
		db.all(
			"SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at",
			[teamId],
			(err, rows) => {
				if (err) reject(err);
				else resolve(rows || []);
			},
		);
	});
}

async function addTeamMember(teamId, userId, username) {
	return new Promise((resolve, reject) => {
		db.run(
			"INSERT INTO team_members (team_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)",
			[teamId, userId, username, Date.now()],
			(err) => {
				if (err) reject(err);
				else resolve();
			},
		);
	});
}

async function updateTeamProgress(teamId, data) {
	return new Promise((resolve, reject) => {
		db.run(
			"UPDATE teams SET level = ?, points = ?, hint_used = ? WHERE team_id = ?",
			[data.level, data.points, JSON.stringify(data.hintUsed), teamId],
			(err) => {
				if (err) reject(err);
				else resolve();
			},
		);
	});
}

async function recordTeamAttempt(
	teamId,
	userId,
	username,
	levelId,
	answer,
	isCorrect,
) {
	return new Promise((resolve, reject) => {
		db.run(
			"INSERT INTO team_attempts (team_id, user_id, username, level_id, answer, is_correct, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			[teamId, userId, username, levelId, answer, isCorrect, Date.now()],
			(err) => {
				if (err) reject(err);
				else resolve();
			},
		);
	});
}

async function getTeamLeaderboard() {
	return new Promise((resolve, reject) => {
		db.all(
			`SELECT t.*, 
			(SELECT COUNT(*) FROM team_members WHERE team_id = t.team_id) as member_count,
			(SELECT MAX(completed_at) FROM team_completed_levels WHERE team_id = t.team_id) as last_completed
			FROM teams t 
			ORDER BY t.points DESC, last_completed ASC LIMIT 10`,
			[],
			(err, rows) => {
				if (err) reject(err);
				else resolve(rows || []);
			},
		);
	});
}

async function getAllTeamsProgress() {
	return new Promise((resolve, reject) => {
		db.all(
			`SELECT t.*, 
			(SELECT COUNT(*) FROM team_members WHERE team_id = t.team_id) as member_count,
			(SELECT MAX(completed_at) FROM team_completed_levels WHERE team_id = t.team_id) as last_completed
			FROM teams t 
			ORDER BY t.points DESC`,
			[],
			(err, rows) => {
				if (err) reject(err);
				else resolve(rows || []);
			},
		);
	});
}

async function getRecentAttempts(limit = 20) {
	return new Promise((resolve, reject) => {
		db.all(
			`SELECT ta.*, t.team_name, t.channel_id 
			FROM team_attempts ta 
			JOIN teams t ON ta.team_id = t.team_id 
			ORDER BY ta.attempted_at DESC LIMIT ?`,
			[limit],
			(err, rows) => {
				if (err) reject(err);
				else resolve(rows || []);
			},
		);
	});
}

// Check if a channel is in the whitelist
function isWhitelistedChannel(channelId) {
	return config.whitelistedChannels.includes(channelId);
}

// Check if user has admin permissions
function isAdmin(interaction) {
	// Check for Administrator permission
	if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
		return true;
	}

	// Check for configured admin roles
	const userRoles = interaction.member.roles.cache.map((role) => role.name);
	return config.admin.roles.some((adminRole) => userRoles.includes(adminRole));
}

// Ensure data directory exists
function ensureDataDirectory() {
	const dataDir = path.join(__dirname, "data");
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
		console.log("Created data directory");
	}
}

// Initialize database with proper error handling
function initializeDatabase() {
	ensureDataDirectory();

	return new Promise((resolve, reject) => {
		const dbPath = path.join(__dirname, "data", "hunt.db");
		const database = new sqlite3.Database(
			dbPath,
			sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
			(err) => {
				if (err) {
					console.error("Database connection error:", err);
					reject(err);
				} else {
					console.log("Connected to database");
					resolve(database);
				}
			},
		);
	});
}

(async () => {
	try {
		// Create tables after successful connection
		db.serialize(() => {
			db.run(`CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY,
        channel_id TEXT UNIQUE,
        team_name TEXT,
        level INTEGER DEFAULT 1,
        points INTEGER DEFAULT 0,
        hint_used TEXT DEFAULT '[]',
        start_time INTEGER,
        created_at INTEGER
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT,
        user_id TEXT,
        username TEXT,
        joined_at INTEGER,
        PRIMARY KEY (team_id, user_id),
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS team_completed_levels (
        team_id TEXT,
        level_id INTEGER,
        completed_at INTEGER,
        points_earned INTEGER,
        completed_by TEXT,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS team_attempts (
        attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT,
        user_id TEXT,
        username TEXT,
        level_id INTEGER,
        answer TEXT,
        is_correct BOOLEAN,
        attempted_at INTEGER,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS first_blood (
        level_id INTEGER PRIMARY KEY,
        team_id TEXT,
        team_name TEXT,
        completed_by TEXT,
        completed_at INTEGER,
        FOREIGN KEY(team_id) REFERENCES teams(team_id)
    )`);

			// Keep existing tables for backward compatibility
			db.run(`CREATE TABLE IF NOT EXISTS user_progress (
        user_id TEXT PRIMARY KEY,
        level INTEGER,
        points INTEGER,
        hint_used TEXT,
        start_time INTEGER
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS completed_levels (
        user_id TEXT,
        level_id INTEGER,
        completed_at INTEGER,
        points_earned INTEGER,
        FOREIGN KEY(user_id) REFERENCES user_progress(user_id)
    )`);

			db.run(`CREATE TABLE IF NOT EXISTS leaderboard (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        points INTEGER,
        level INTEGER,
        start_time INTEGER,
        last_completed INTEGER,
        FOREIGN KEY(user_id) REFERENCES user_progress(user_id)
    )`);
		});

		console.log("Database initialized successfully");
	} catch (error) {
		console.error("Failed to initialize database:", error);
		process.exit(1);
	}
})();

// When client is ready
client.once("ready", () => {
	console.log(`Logged in as ${client.user.tag}`);

	// Register slash commands
	const commands = [
		new SlashCommandBuilder()
			.setName("createteam")
			.setDescription("Create a team for this channel")
			.addStringOption((option) =>
				option.setName("name").setDescription("Team name").setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("jointeam")
			.setDescription("Join the team in this channel"),

		new SlashCommandBuilder()
			.setName("teaminfo")
			.setDescription("View team information"),

		new SlashCommandBuilder()
			.setName("hunt")
			.setDescription("Get your team's current cryptic hunt question"),

		new SlashCommandBuilder()
			.setName("answer")
			.setDescription("Submit an answer for your team's current level")
			.addStringOption((option) =>
				option
					.setName("solution")
					.setDescription("Your answer")
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("leaderboard")
			.setDescription("View the hunt leaderboard"),

		new SlashCommandBuilder()
			.setName("hint")
			.setDescription("Request a hint for your team's current level"),

		new SlashCommandBuilder()
			.setName("help")
			.setDescription("Get information about how to play the hunt"),

		new SlashCommandBuilder()
			.setName("previous")
			.setDescription("View your team's previously completed questions"),

		// Admin commands
		new SlashCommandBuilder()
			.setName("adminprogress")
			.setDescription("View all teams' progress (Admin only)")
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("adminattempts")
			.setDescription("View recent attempts across all teams (Admin only)")
			.addIntegerOption((option) =>
				option
					.setName("limit")
					.setDescription("Number of attempts to show (default 20)")
					.setMinValue(1)
					.setMaxValue(50),
			)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("firstblood")
			.setDescription("View first blood statistics"),

		new SlashCommandBuilder()
			.setName("adminfirstblood")
			.setDescription("View detailed first blood statistics (Admin only)")
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
	];

	client.application.commands.set(commands);
	console.log("Slash commands registered");
});

// Check if this is the first team to complete a level
async function checkFirstBlood(levelId, teamId, teamName, completedBy) {
	return new Promise((resolve, reject) => {
		db.get(
			"SELECT * FROM first_blood WHERE level_id = ?",
			[levelId],
			(err, row) => {
				if (err) {
					reject(err);
					return;
				}

				if (row) {
					// Level already has first blood
					resolve(false);
				} else {
					// This is first blood! Record it
					db.run(
						"INSERT INTO first_blood (level_id, team_id, team_name, completed_by, completed_at) VALUES (?, ?, ?, ?, ?)",
						[levelId, teamId, teamName, completedBy, Date.now()],
						(err) => {
							if (err) {
								reject(err);
							} else {
								resolve(true);
							}
						},
					);
				}
			},
		);
	});
}

// Send first blood announcement to first blood channel
async function announceFirstBlood(levelId, teamName, completedBy, points) {
	if (!config.logging.firstBloodChannelId) return;

	const embed = new EmbedBuilder()
		.setTitle("🩸 FIRST BLOOD! 🩸")
		.setDescription(
			`**Team ${teamName}** has taken first blood on level ${levelId}!`,
		)
		.setColor("#FF0000")
		.addFields(
			{ name: "Solved by", value: completedBy, inline: true },
			{ name: "Points Earned", value: points.toString(), inline: true },
			{ name: "Level", value: levelId.toString(), inline: true },
		)
		.setTimestamp();

	try {
		const channel = await client.channels.fetch(
			config.logging.firstBloodChannelId,
		);
		if (channel?.isTextBased()) {
			await channel.send({ embeds: [embed] });
		}
	} catch (error) {
		console.error(
			`Failed to send first blood announcement to channel ${config.logging.firstBloodChannelId}:`,
			error,
		);
	}
}

// Log attempt to channel
async function logAttemptToChannel(
	teamName,
	username,
	levelId,
	answer,
	isCorrect,
	channelId,
) {
	if (!config.logging.attemptChannelId) return;

	const status = isCorrect ? "✅ CORRECT" : "❌ INCORRECT";
	const color = isCorrect ? "#00FF00" : "#FF0000";

	const embed = new EmbedBuilder()
		.setTitle(`${status} Answer Attempt`)
		.setColor(color)
		.addFields(
			{ name: "Team", value: teamName, inline: true },
			{ name: "Player", value: username, inline: true },
			{ name: "Level", value: levelId.toString(), inline: true },
			{ name: "Answer", value: `"${answer}"`, inline: false },
			{ name: "Channel", value: `<#${channelId}>`, inline: true },
		)
		.setTimestamp();

	try {
		const logChannel = await client.channels.fetch(
			config.logging.attemptChannelId,
		);
		if (logChannel?.isTextBased()) {
			await logChannel.send({ embeds: [embed] });
		}
	} catch (error) {
		console.error(
			`Failed to log attempt to channel ${config.logging.attemptChannelId}:`,
			error,
		);
	}
}

// Get first blood statistics
async function getFirstBloodStats() {
	return new Promise((resolve, reject) => {
		db.all(
			"SELECT * FROM first_blood ORDER BY level_id ASC",
			[],
			(err, rows) => {
				if (err) reject(err);
				else resolve(rows || []);
			},
		);
	});
}

// Post level question to channel and pin it
async function postAndPinLevel(channelId, levelData, teamName, teamPoints) {
	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel?.isTextBased()) return;

		// Unpin previous level messages
		const pinnedMessages = await channel.messages.fetchPinned();
		for (const [, message] of pinnedMessages) {
			if (message.author.id === client.user.id && message.embeds.length > 0) {
				const embed = message.embeds[0];
				if (embed.title?.includes("Level") && embed.title?.includes("Team:")) {
					await message.unpin().catch(() => {}); // Ignore errors
				}
			}
		}

		const embed = new EmbedBuilder()
			.setTitle(`🎯 Level ${levelData.id} - Team: ${teamName}`)
			.setDescription(levelData.question)
			.setColor("#00BFFF")
			.addFields(
				{
					name: "💰 Points Available",
					value: levelData.points.toString(),
					inline: true,
				},
				{ name: "🏆 Team Points", value: teamPoints.toString(), inline: true },
				{
					name: "💡 Commands",
					value: "`/answer <solution>` • `/hint` • `/progress`",
					inline: false,
				},
			)
			.setFooter({ text: "Good luck! Use /answer to submit your solution." })
			.setTimestamp();

		if (levelData.image) {
			embed.setImage(levelData.image);
		}

		const message = await channel.send({
			content: `🚀 **New Level Available!** Team ${teamName} is now on Level ${levelData.id}`,
			embeds: [embed],
		});

		await message.pin();
		return message;
	} catch (error) {
		console.error("Error posting and pinning level:", error);
	}
}

// Send completion celebration message
async function sendCompletionCelebration(
	channelId,
	teamName,
	totalPoints,
	completedLevels,
	totalLevels,
) {
	try {
		const channel = await client.channels.fetch(channelId);
		if (!channel?.isTextBased()) return;

		const embed = new EmbedBuilder()
			.setTitle("🎊 HUNT COMPLETED! 🎊")
			.setDescription(
				`**Team ${teamName}** has successfully completed the Cryptic Hunt!`,
			)
			.setColor("#FFD700")
			.addFields(
				{
					name: "🏆 Final Score",
					value: `${totalPoints} points`,
					inline: true,
				},
				{
					name: "📊 Levels Completed",
					value: `${completedLevels}/${totalLevels}`,
					inline: true,
				},
				{ name: "🎯 Achievement", value: "Hunt Master", inline: true },
			)
			.setThumbnail("https://cdn.discordapp.com/emojis/tada.png")
			.setFooter({ text: "Congratulations on your achievement!" })
			.setTimestamp();

		await channel.send({
			content: `🎉 **CONGRATULATIONS!** ${teamName} has conquered the Cryptic Hunt! 🏆`,
			embeds: [embed],
		});
	} catch (error) {
		console.error("Error sending completion celebration:", error);
	}
}

// Initialize database
initializeDatabase();

// Handle interactions
client.on("interactionCreate", async (interaction) => {
	if (!interaction.isCommand()) return;

	// Check if the command is used in a whitelisted channel
	if (!isWhitelistedChannel(interaction.channelId)) {
		return interaction.reply({
			content:
				config.messages.noPermissionMessage ||
				"This command can only be used in designated channels.",
			ephemeral: true,
		});
	}

	const { commandName } = interaction;
	const userId = interaction.user.id;
	const username = interaction.user.username;

	try {
		switch (commandName) {
			case "createteam": {
				const teamName = interaction.options.getString("name");

				// Validate team name length
				if (teamName.length > 50) {
					return interaction.reply({
						content: "Team name must be 50 characters or less.",
						ephemeral: true,
					});
				}

				// Check if team already exists in this channel
				const existingTeam = await getTeamByChannel(interaction.channelId);
				if (existingTeam) {
					return interaction.reply({
						content: "A team already exists in this channel!",
						ephemeral: true,
					});
				}

				const teamId = await createTeam(
					interaction.channelId,
					teamName,
					userId,
					username,
				);

				// Post the first level immediately
				const firstLevel = huntData.levels.find((level) => level.id === 1);
				if (firstLevel) {
					await postAndPinLevel(interaction.channelId, firstLevel, teamName, 0);
				}

				return interaction.reply({
					content: `🎯 Team "${teamName}" created and ready to hunt! Your first challenge has been posted above. Use \`/jointeam\` for others to join.`,
					ephemeral: false,
				});
			}

			case "jointeam": {
				const team = await getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel. Use `/createteam` first.",
						ephemeral: true,
					});
				}

				const members = await getTeamMembers(team.team_id);
				if (members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: "You are already a member of this team!",
						ephemeral: true,
					});
				}

				if (members.length >= config.hunt.maxTeamSize) {
					return interaction.reply({
						content:
							config.messages.teamFullMessage ||
							`This team is full (maximum ${config.hunt.maxTeamSize} members)!`,
						ephemeral: true,
					});
				}

				await addTeamMember(team.team_id, userId, username);

				// Send a welcoming message with current status
				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				let welcomeMessage = `🎉 ${username} joined Team ${team.team_name}!`;

				if (currentLevel) {
					welcomeMessage += ` You're currently working on Level ${team.level}. Check the pinned message above for the current challenge.`;
				}

				return interaction.reply({
					content: welcomeMessage,
					ephemeral: false,
				});
			}

			case "teaminfo": {
				const team = await getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = await getTeamMembers(team.team_id);
				const memberList = members.map((m) => m.username).join(", ");

				const embed = new EmbedBuilder()
					.setTitle(`Team: ${team.team_name}`)
					.setColor("#0099ff")
					.addFields(
						{ name: "Members", value: memberList || "None" },
						{ name: "Current Level", value: team.level.toString() },
						{ name: "Points", value: team.points.toString() },
						{
							name: "Team Size",
							value: `${members.length}/${config.hunt.maxTeamSize}`,
						},
					);

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "adminprogress": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content:
							config.messages.noPermissionMessage ||
							"You don't have permission to use this command.",
						ephemeral: true,
					});
				}

				const allTeams = await getAllTeamsProgress();
				if (allTeams.length === 0) {
					return interaction.reply({
						content: "No teams found.",
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle("All Teams Progress")
					.setColor("#FF0000");

				const progressText = allTeams
					.map((team, index) => {
						const lastCompleted = team.last_completed
							? new Date(team.last_completed).toLocaleString()
							: "Never";
						return `**${index + 1}. ${team.team_name}** (${team.member_count} members)\nLevel: ${team.level - 1} completed | Points: ${team.points}\nLast activity: ${lastCompleted}\nChannel: <#${team.channel_id}>\n`;
					})
					.join("\n");

				// Split into multiple embeds if too long
				if (progressText.length > 4096) {
					const chunks = progressText.match(/.{1,4000}/g) || [];
					for (let i = 0; i < chunks.length; i++) {
						const chunkEmbed = new EmbedBuilder()
							.setTitle(
								i === 0
									? "All Teams Progress"
									: `All Teams Progress (${i + 1})`,
							)
							.setColor("#FF0000")
							.setDescription(chunks[i]);

						await interaction.reply({ embeds: [chunkEmbed], ephemeral: true });
					}
				} else {
					embed.setDescription(progressText);
					return interaction.reply({ embeds: [embed], ephemeral: true });
				}
				break;
			}

			case "adminattempts": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content:
							config.messages.noPermissionMessage ||
							"You don't have permission to use this command.",
						ephemeral: true,
					});
				}

				const limit = interaction.options.getInteger("limit") || 20;
				const attempts = await getRecentAttempts(limit);

				if (attempts.length === 0) {
					return interaction.reply({
						content: "No attempts found.",
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(`Recent Attempts (Last ${attempts.length})`)
					.setColor("#FFA500");

				const attemptsText = attempts
					.map((attempt) => {
						const status = attempt.is_correct ? "✅" : "❌";
						const time = new Date(attempt.attempted_at).toLocaleString();
						return `${status} **${attempt.team_name}** - ${attempt.username}\nLevel ${attempt.level_id}: "${attempt.answer}"\n${time} | <#${attempt.channel_id}>\n`;
					})
					.join("\n");

				embed.setDescription(attemptsText);
				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "firstblood": {
				try {
					const firstBloodStats = await getFirstBloodStats();
					if (firstBloodStats.length === 0) {
						return interaction.reply({
							content: "No first blood records yet!",
							ephemeral: true,
						});
					}

					const embed = new EmbedBuilder()
						.setTitle("🩸 First Blood Hall of Fame")
						.setColor("#FF0000")
						.setDescription("Teams that achieved first blood on each level");

					const statsText = firstBloodStats
						.map((stat) => {
							const completedAt = new Date(stat.completed_at).toLocaleString();
							return `**Level ${stat.level_id}** - Team ${stat.team_name}\nSolved by: ${stat.completed_by}\nTime: ${completedAt}`;
						})
						.join("\n\n");

					embed.setDescription(statsText);

					return interaction.reply({ embeds: [embed], ephemeral: false });
				} catch (error) {
					console.error("Error in firstblood command:", error);
					return interaction.reply({
						content: "An error occurred while fetching first blood statistics.",
						ephemeral: true,
					});
				}
			}

			case "adminfirstblood": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content:
							config.messages.noPermissionMessage ||
							"You don't have permission to use this command.",
						ephemeral: true,
					});
				}

				try {
					const firstBloodStats = await getFirstBloodStats();
					if (firstBloodStats.length === 0) {
						return interaction.reply({
							content: "No first blood records yet!",
							ephemeral: true,
						});
					}

					const embed = new EmbedBuilder()
						.setTitle("🩸 Admin First Blood Statistics")
						.setColor("#FF0000");

					const statsText = firstBloodStats
						.map((stat) => {
							const completedAt = new Date(stat.completed_at);
							const timeStr = completedAt.toLocaleString();
							return `**Level ${stat.level_id}** - ${stat.team_name} (ID: ${stat.team_id})\nSolved by: ${stat.completed_by}\nCompleted: ${timeStr}\nTimestamp: ${stat.completed_at}`;
						})
						.join("\n\n");

					embed.setDescription(statsText);

					return interaction.reply({ embeds: [embed], ephemeral: true });
				} catch (error) {
					console.error("Error in adminfirstblood command:", error);
					return interaction.reply({
						content: "An error occurred while fetching first blood statistics.",
						ephemeral: true,
					});
				}
			}

			// Modified existing commands to work with teams
			case "hunt": {
				const team = await getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel. Use `/createteam` first.",
						ephemeral: true,
					});
				}

				const members = await getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content:
							"You are not a member of this team. Use `/jointeam` to join.",
						ephemeral: true,
					});
				}

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				if (!currentLevel) {
					return interaction.reply({
						content: "Your team has completed all levels! Congratulations! 🎉",
						ephemeral: true,
					});
				}

				// Reply to interaction immediately
				await interaction.reply({
					content: "📌 Reposting and pinning your current level...",
					ephemeral: true,
				});

				// Repost and pin the current level as a separate action
				await postAndPinLevel(
					interaction.channelId,
					currentLevel,
					team.team_name,
					team.points,
				);

				// Send a follow-up message
				try {
					const channel = await client.channels.fetch(interaction.channelId);
					if (channel?.isTextBased()) {
						await channel.send(
							"📌 **Current level has been reposted and pinned above!**",
						);
					}
				} catch (error) {
					console.error("Error sending follow-up message:", error);
				}

				break;
			}

			case "answer": {
				const team = await getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = await getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: "You are not a member of this team.",
						ephemeral: true,
					});
				}

				const answer = interaction.options
					.getString("solution")
					.trim()
					.toLowerCase();
				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);

				if (!currentLevel) {
					return interaction.reply({
						content: "Your team has completed all levels!",
						ephemeral: true,
					});
				}

				const correctAnswer = Array.isArray(currentLevel.answer)
					? currentLevel.answer.map((a) => a.toLowerCase())
					: [currentLevel.answer.toLowerCase()];

				const isCorrect = correctAnswer.includes(answer);

				// Record team attempt in database
				await recordTeamAttempt(
					team.team_id,
					userId,
					username,
					currentLevel.id,
					answer,
					isCorrect,
				);

				// Log attempt to channel
				await logAttemptToChannel(
					team.team_name,
					username,
					currentLevel.id,
					answer,
					isCorrect,
					interaction.channelId,
				);

				if (isCorrect) {
					const levelPoints = currentLevel.points || 100;
					let pointsEarned = levelPoints;

					if (team.hintUsed.includes(currentLevel.id)) {
						pointsEarned = Math.floor(
							pointsEarned * (1 - config.hunt.hintPenalty),
						);
					}

					// Check for first blood
					const isFirstBlood = await checkFirstBlood(
						currentLevel.id,
						team.team_id,
						team.team_name,
						username,
					);

					// Add first blood bonus if enabled
					if (isFirstBlood && config.features.firstBloodBonus) {
						const bonusPoints = Math.floor(
							pointsEarned * config.features.firstBloodBonusMultiplier,
						);
						pointsEarned += bonusPoints;
					}

					team.points += pointsEarned;
					team.level++;

					// Record completion
					await new Promise((resolve, reject) => {
						db.run(
							"INSERT INTO team_completed_levels (team_id, level_id, completed_at, points_earned, completed_by) VALUES (?, ?, ?, ?, ?)",
							[
								team.team_id,
								currentLevel.id,
								Date.now(),
								pointsEarned,
								username,
							],
							(err) => {
								if (err) reject(err);
								else resolve();
							},
						);
					});

					await updateTeamProgress(team.team_id, team);

					// Send first blood announcement if this is first blood
					if (isFirstBlood) {
						await announceFirstBlood(
							currentLevel.id,
							team.team_name,
							username,
							pointsEarned,
						);
					}

					const nextLevel = huntData.levels.find(
						(level) => level.id === team.level,
					);

					let successMessage = `🎉 **CORRECT!** Team ${team.team_name} (solved by ${username}) earned ${pointsEarned} points`;

					if (isFirstBlood) {
						successMessage += " and achieved **FIRST BLOOD** 🩸";
						if (config.features.firstBloodBonus) {
							successMessage += ` (bonus points included)`;
						}
					}

					if (nextLevel) {
						successMessage += ` and advanced to Level ${nextLevel.id}!`;

						// Reply to interaction immediately
						await interaction.reply({
							content:
								successMessage +
								"\n\n🎯 **Your next challenge is being prepared...**",
						});

						// Post and pin the next level as a separate message
						await postAndPinLevel(
							interaction.channelId,
							nextLevel,
							team.team_name,
							team.points,
						);

						// Send a follow-up message
						try {
							const channel = await client.channels.fetch(
								interaction.channelId,
							);
							if (channel?.isTextBased()) {
								await channel.send(
									"📌 **Your next challenge has been posted and pinned above!**",
								);
							}
						} catch (error) {
							console.error("Error sending follow-up message:", error);
						}
					} else {
						// Hunt completed!
						successMessage += "! 🏆 **HUNT COMPLETED!** Congratulations!";

						// Reply to interaction immediately
						await interaction.reply({
							content: successMessage,
						});

						// Send completion celebration as a separate message
						await sendCompletionCelebration(
							interaction.channelId,
							team.team_name,
							team.points,
							huntData.levels.length,
							huntData.levels.length,
						);
					}
				} else {
					// Wrong answer with encouragement
					const wrongMessages = [
						"❌ Not quite right. Keep thinking! 🤔",
						"❌ That's not it, but don't give up! 💪",
						"❌ Close, but not there yet. Try again! 🎯",
						"❌ Incorrect, but every attempt gets you closer! 🚀",
					];
					const randomMessage =
						wrongMessages[Math.floor(Math.random() * wrongMessages.length)];

					return interaction.reply({
						content: randomMessage,
						ephemeral: true,
					});
				}

				break;
			}

			case "leaderboard": {
				try {
					const leaderboard = await getTeamLeaderboard();
					if (leaderboard.length === 0) {
						return interaction.reply({
							content: "No teams found on the leaderboard yet!",
							ephemeral: true,
						});
					}

					const embed = new EmbedBuilder()
						.setTitle("🏆 Team Leaderboard")
						.setColor("#FFD700")
						.setDescription("Top performing teams in the hunt");

					const leaderboardText = leaderboard
						.map((team, index) => {
							const medal =
								index === 0
									? "🥇"
									: index === 1
										? "🥈"
										: index === 2
											? "🥉"
											: `${index + 1}.`;
							const completedLevels = team.level - 1;
							const lastActivity = team.last_completed
								? new Date(team.last_completed).toLocaleString()
								: "No completions yet";

							return `${medal} **${team.team_name}** (${team.member_count} members)\n🎯 Level: ${completedLevels} completed | 💰 Points: ${team.points}\n⏰ Last activity: ${lastActivity}\n`;
						})
						.join("\n");

					embed.setDescription(leaderboardText);
					embed.setFooter({ text: "Keep hunting! 🔍" });

					return interaction.reply({ embeds: [embed], ephemeral: false });
				} catch (error) {
					console.error("Error in leaderboard command:", error);
					return interaction.reply({
						content: "An error occurred while fetching the leaderboard.",
						ephemeral: true,
					});
				}
			}

			case "help": {
				const embed = new EmbedBuilder()
					.setTitle("🎯 Cryptic Hunt - How to Play")
					.setColor("#0099ff")
					.setDescription(
						"Welcome to the team-based cryptic hunt! Here's how to get started:",
					)
					.addFields(
						{
							name: "🚀 Getting Started",
							value:
								"• Use `/createteam <name>` to create a team in this channel\n• Others can join with `/jointeam`\n• Teams can have up to " +
								(config.hunt?.maxTeamSize || 4) +
								" members",
							inline: false,
						},
						{
							name: "🎮 Playing the Hunt",
							value:
								"• Use `/hunt` to see your current challenge\n• Submit answers with `/answer <solution>`\n• Get hints with `/hint` (reduces points)\n• Check team info with `/teaminfo`",
							inline: false,
						},
						{
							name: "🏆 Scoring & Competition",
							value:
								"• Teams earn points for correct answers\n• First team to solve gets 🩸 **FIRST BLOOD**\n• Check rankings with `/leaderboard`\n• View completed levels with `/previous`",
							inline: false,
						},
						{
							name: "ℹ️ Team Commands",
							value:
								"• `/teaminfo` - View team details\n• `/jointeam` - Join the team in this channel\n• `/firstblood` - See first blood achievements",
							inline: false,
						},
					)
					.setFooter({ text: "Good luck hunting! 🔍" });

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "previous": {
				const team = await getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = await getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: "You are not a member of this team.",
						ephemeral: true,
					});
				}

				// Get completed levels for this team
				const completedLevels = await new Promise((resolve, reject) => {
					db.all(
						"SELECT * FROM team_completed_levels WHERE team_id = ? ORDER BY completed_at ASC",
						[team.team_id],
						(err, rows) => {
							if (err) reject(err);
							else resolve(rows || []);
						},
					);
				});

				if (completedLevels.length === 0) {
					return interaction.reply({
						content: "Your team hasn't completed any levels yet!",
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(`📚 Completed Levels - Team ${team.team_name}`)
					.setColor("#00FF00")
					.setDescription("Here are the levels your team has conquered:");

				const levelTexts = completedLevels.map((completed) => {
					const level = huntData.levels.find(
						(l) => l.id === completed.level_id,
					);
					const completedAt = new Date(completed.completed_at).toLocaleString();

					return `**Level ${completed.level_id}**: ${level?.question || "Question not found"}\n✅ Solved by: ${completed.completed_by}\n💰 Points earned: ${completed.points_earned}\n🕐 Completed: ${completedAt}`;
				});

				// Split into chunks if too long
				const maxLength = 4096;
				let currentText = levelTexts.join("\n\n");

				if (currentText.length > maxLength) {
					const chunks = [];
					let currentChunk = "";

					for (const levelText of levelTexts) {
						if ((currentChunk + levelText).length > maxLength) {
							chunks.push(currentChunk);
							currentChunk = levelText;
						} else {
							currentChunk += (currentChunk ? "\n\n" : "") + levelText;
						}
					}
					if (currentChunk) chunks.push(currentChunk);

					// Send first chunk as reply
					embed.setDescription(chunks[0]);
					await interaction.reply({ embeds: [embed], ephemeral: true });

					// Send remaining chunks as follow-ups
					for (let i = 1; i < chunks.length; i++) {
						const followUpEmbed = new EmbedBuilder()
							.setTitle(
								`📚 Completed Levels - Team ${team.team_name} (${i + 1})`,
							)
							.setColor("#00FF00")
							.setDescription(chunks[i]);

						await interaction.followUp({
							embeds: [followUpEmbed],
							ephemeral: true,
						});
					}
				} else {
					embed.setDescription(currentText);
					return interaction.reply({ embeds: [embed], ephemeral: true });
				}
				break;
			}

			// ...existing code for other commands...
		}
	} catch (error) {
		console.error(`Error in ${commandName} command:`, error);

		if (!interaction.replied && !interaction.deferred) {
			return interaction.reply({
				content:
					"An error occurred while processing your command. Please try again.",
				ephemeral: true,
			});
		}
	}
});

// Add database backup functionality
function backupDatabase() {
	if (!config.database.backup.enabled) return;

	const backupDir = path.join(__dirname, "data", "backups");
	if (!fs.existsSync(backupDir)) {
		fs.mkdirSync(backupDir, { recursive: true });
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = path.join(backupDir, `hunt_backup_${timestamp}.db`);

	try {
		fs.copyFileSync(path.join(__dirname, "data", "hunt.db"), backupPath);
		console.log(`Database backed up to ${backupPath}`);

		// Clean up old backups
		const backups = fs
			.readdirSync(backupDir)
			.filter((file) => file.startsWith("hunt_backup_"))
			.sort()
			.reverse();

		if (backups.length > config.database.backup.maxBackups) {
			const toDelete = backups.slice(config.database.backup.maxBackups);
			// biome-ignore lint/complexity/noForEach: <explanation>
			toDelete.forEach((file) => {
				fs.unlinkSync(path.join(backupDir, file));
				console.log(`Deleted old backup: ${file}`);
			});
		}
	} catch (error) {
		console.error("Failed to backup database:", error);
	}
}

// Schedule database backups
if (config.database.backup.enabled) {
	setInterval(backupDatabase, config.database.backup.interval);
}

// Add cleanup function at the end
function cleanup() {
	console.log("Cleaning up...");
	db.close((err) => {
		if (err) {
			console.error("Error closing database:", err);
			process.exit(1);
		}
		console.log("Database connection closed");
		process.exit(0);
	});
}

// Handle shutdown signals
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (error) => {
	console.error("Uncaught exception:", error);
	cleanup();
});

// Start the client last
client.login(process.env.DISCORD_TOKEN || config.token);
