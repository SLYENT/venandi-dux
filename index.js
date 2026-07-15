const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	SlashCommandBuilder,
	PermissionFlagsBits,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const config = require("./config.json");
const Database = require("better-sqlite3");

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function ensureDataDirectory() {
	const dataDir = path.join(__dirname, "data");
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
		console.log("Created data directory");
	}
}

ensureDataDirectory();
const db = new Database(path.join(__dirname, "data", "hunt.db"));

// optimize performance
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

console.log("DB initialized");

// load hunt data
let huntData;
try {
	huntData = require("./hunt.json");
} catch (error) {
	console.error("Error with hunt", error);
	process.exit(1);
}

// create tables
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

console.log("Tables verified");

// Team management functions
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

// Check if a channel is in the whitelist
function isWhitelistedChannel(channelId) {
	return config.whitelistedChannels.includes(channelId);
}

// Check if user has admin permissions
function isAdmin(interaction) {
	if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
		return true;
	}
	const userRoles = interaction.member.roles.cache.map((role) => role.name);
	return config.admin.roles.some((adminRole) => userRoles.includes(adminRole));
}

// Check if this is the first team to complete a level
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

// Send first blood announcement
async function announceFirstBlood(levelId, teamName, completedBy, points) {
	if (!config.logging.firstBloodChannelId) return;

	const embed = new EmbedBuilder()
		.setTitle("🩸 FIRST BLOOD! 🩸")
		.setDescription(
			`**Team ${teamName}** has taken first blood on level ${levelId}!`,
		)
		.setColor("#FF0000")
		.addFields(
			{ name: "Answered by", value: completedBy, inline: true },
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
		console.error("Failed to send first blood announcement:", error);
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
		console.error("Failed to log attempt:", error);
	}
}

// Post level question and pin it
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
					await message.unpin().catch(() => {});
				}
			}
		}

		const embed = new EmbedBuilder()
			.setTitle(
				`Level ${levelData.id} - ${levelData.levelname || "Unnamed Level"}`,
			)
			.setDescription(levelData.question)
			.setColor("#00BFFF")
			.addFields(
				{
					name: "Question Points",
					value: levelData.points.toString(),
					inline: true,
				},
				{ name: "Team Points", value: teamPoints.toString(), inline: true },
			)
			.setFooter({ text: "Good luck! Use /answer to submit your solution." })
			.setTimestamp();

		if (levelData.image) {
			embed.setImage(levelData.image);
		}

		const message = await channel.send({
			content: `🚀 **You have advanced to a new level** Team ${teamName} is now on Level ${levelData.id}`,
			embeds: [embed],
		});

		await message.pin();
		return message;
	} catch (error) {
		console.error("Error posting and pinning level:", error);
	}
}

// Send completion celebration
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
			)
			.setFooter({ text: "Congratulations" })
			.setTimestamp();

		await channel.send({
			content: "🎉*CONGRATULATIONS!",
			embeds: [embed],
		});
	} catch (error) {
		console.error("Error sending completion celebration:", error);
	}
}

// Send progress update
async function sendProgressUpdate(
	teamName,
	levelId,
	completedBy,
	pointsEarned,
	totalPoints,
	isFirstBlood,
) {
	if (!config.logging.progressChannelId) return;

	const embed = new EmbedBuilder()
		.setTitle("📈 Level Completed!")
		.setDescription(`**Team ${teamName}** has completed Level ${levelId}!`)
		.setColor(isFirstBlood ? "#FF0000" : "#00FF00")
		.addFields(
			{ name: "Solved by", value: completedBy, inline: true },
			{ name: "Points Earned", value: pointsEarned.toString(), inline: true },
			{ name: "Total Points", value: totalPoints.toString(), inline: true },
			{ name: "Level", value: levelId.toString(), inline: true },
		)
		.setTimestamp();

	if (isFirstBlood) {
		embed.addFields({
			name: "Achievement",
			value: "🩸 **FIRST BLOOD**",
			inline: true,
		});
	}

	try {
		const channel = await client.channels.fetch(
			config.logging.progressChannelId,
		);
		if (channel?.isTextBased()) {
			await channel.send({ embeds: [embed] });
		}
	} catch (error) {
		console.error("Failed to send progress update:", error);
	}
}

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

// Handle interactions
client.on("interactionCreate", async (interaction) => {
	if (!interaction.isCommand()) return;

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

				if (teamName.length > 50) {
					return interaction.reply({
						content: "Team name must be 50 characters or less.",
						ephemeral: true,
					});
				}

				const existingTeam = getTeamByChannel(interaction.channelId);
				if (existingTeam) {
					return interaction.reply({
						content: "A team already exists in this channel!",
						ephemeral: true,
					});
				}

				const teamId = createTeam(
					interaction.channelId,
					teamName,
					userId,
					username,
				);

				const firstLevel = huntData.levels.find((level) => level.id === 1);
				if (firstLevel) {
					await postAndPinLevel(interaction.channelId, firstLevel, teamName, 0);
				}

				return interaction.reply({
					content: `🎯 Team "${teamName}" created and ready to hunt! Your first level has been posted above. Use \`/jointeam\` for others to join within this channel.`,
					ephemeral: false,
				});
			}

			case "jointeam": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel. Use `/createteam` first.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
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

				addTeamMember(team.team_id, userId, username);

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				let welcomeMessage = ` ${username} joined Team ${team.team_name}!`;

				if (currentLevel) {
					welcomeMessage += ` You're currently working on Level ${team.level}. Check the pinned message above for the current level.`;
				}

				return interaction.reply({
					content: welcomeMessage,
					ephemeral: false,
				});
			}

			case "teaminfo": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
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

				const allTeams = getAllTeamsProgress();
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

						if (i === 0) {
							await interaction.reply({
								embeds: [chunkEmbed],
								ephemeral: true,
							});
						} else {
							await interaction.followUp({
								embeds: [chunkEmbed],
								ephemeral: true,
							});
						}
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
				const attempts = getRecentAttempts(limit);

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
				const firstBloodStats = getFirstBloodStats();
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

				const firstBloodStats = getFirstBloodStats();
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
			}

			case "hunt": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel. Use `/createteam` first.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
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

				await interaction.reply({
					content: "📌 Reposting your current level...",
					ephemeral: true,
				});

				await postAndPinLevel(
					interaction.channelId,
					currentLevel,
					team.team_name,
					team.points,
				);

				const channel = await client.channels.fetch(interaction.channelId);
				if (channel?.isTextBased()) {
					await channel.send(
						"📌 **Current level has been reposted and pinned above!**",
					);
				}
				break;
			}

			case "answer": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
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

				recordTeamAttempt(
					team.team_id,
					userId,
					username,
					currentLevel.id,
					answer,
					isCorrect,
				);

				logAttemptToChannel(
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

					let isFirstBlood = false;
					try {
						isFirstBlood = checkFirstBlood(
							currentLevel.id,
							team.team_id,
							team.team_name,
							username,
						);
					} catch (error) {
						console.error("Error checking first blood:", error);
					}

					if (isFirstBlood && config.features?.firstBloodBonus) {
						pointsEarned += 20;
					}

					team.points += pointsEarned;
					team.level++;

					const completionStmt = db.prepare(
						"INSERT INTO team_completed_levels (team_id, level_id, completed_at, points_earned, completed_by) VALUES (?, ?, ?, ?, ?)",
					);
					completionStmt.run(
						team.team_id,
						currentLevel.id,
						Date.now(),
						pointsEarned,
						username,
					);

					updateTeamProgress(team.team_id, team);

					sendProgressUpdate(
						team.team_name,
						currentLevel.id,
						username,
						pointsEarned,
						team.points,
						isFirstBlood,
					);

					if (isFirstBlood) {
						announceFirstBlood(
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
						if (config.features?.firstBloodBonus) {
							successMessage += " (+20 bonus points included)";
						}
					}

					if (nextLevel) {
						successMessage += ` and advanced to Level ${nextLevel.id}!`;

						await interaction.reply({
							content: `${successMessage}\n\n🎯 **Your next level is being prepared...**`,
						});

						await postAndPinLevel(
							interaction.channelId,
							nextLevel,
							team.team_name,
							team.points,
						);

						const channel = await client.channels.fetch(interaction.channelId);
						if (channel?.isTextBased()) {
							await channel.send(
								"📌 **Your next question has been posted and pinned above!**",
							);
						}
					} else {
						successMessage += "! 🏆 **HUNT COMPLETED!** Congratulations!";

						await interaction.reply({
							content: successMessage,
						});

						sendCompletionCelebration(
							interaction.channelId,
							team.team_name,
							team.points,
							huntData.levels.length,
							huntData.levels.length,
						);
					}
				} else {
					const wrongMessages = ["❌ Wrong Answer", "❌ Incorrect Answer"];
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
				const leaderboard = getTeamLeaderboard();
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
				embed.setFooter({ text: "Keep hunting" });

				return interaction.reply({ embeds: [embed], ephemeral: false });
			}

			case "hint": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: "You are not a member of this team.",
						ephemeral: true,
					});
				}

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				if (!currentLevel) {
					return interaction.reply({
						content: "Your team has completed all levels!",
						ephemeral: true,
					});
				}

				if (!currentLevel.hint) {
					return interaction.reply({
						content: "No hint available for this level. 🤷‍♂️",
						ephemeral: true,
					});
				}

				const alreadyUsed = team.hintUsed.includes(currentLevel.id);

				if (!alreadyUsed) {
					team.hintUsed.push(currentLevel.id);
					updateTeamProgress(team.team_id, team);
				}

				const embed = new EmbedBuilder()
					.setTitle(`💡 Hint for Level ${currentLevel.id}`)
					.setColor("#FFD700")
					.setDescription(currentLevel.hint)
					.setFooter({
						text: alreadyUsed
							? "Hint already used for this level"
							: `Using this hint reduces points by ${Math.round(config.hunt.hintPenalty * 100)}%`,
					});

				return interaction.reply({
					embeds: [embed],
					ephemeral: false,
				});
			}

			case "help": {
				const embed = new EmbedBuilder()
					.setTitle("🎯 Cryptic Hunt - How to Play")
					.setColor("#0099ff")
					.setDescription("Welcome to Cryptic 26! Here's how to get started:")
					.addFields(
						{
							name: "🕸️ Getting Started",
							value: `• Use \`/createteam <name>\` to create a team in this channel\n• Others can join with \`/jointeam\`\n• Teams can have up to ${config.hunt?.maxTeamSize || 4} members`,
							inline: false,
						},
						{
							name: "▶️ Actually Playing",
							value:
								"• Use `/hunt` to see your current challenge\n• Submit answers with `/answer <solution>`\n• Get hints with `/hint` (reduces points)\n• Check team info with `/teaminfo`",
							inline: false,
						},
						{
							name: "🏆 Scoring & Competition",
							value:
								"• Teams earn points for correct answers\n• First team to solve gets 🩸 **FIRST BLOOD** (and a small tiebreaker bonus)\n• Check rankings with `/leaderboard`\n• View completed levels with `/previous`",
							inline: false,
						},
						{
							name: "ℹ️ Team Commands",
							value:
								"• `/teaminfo` - View team details\n• `/jointeam` - Join the team in this channel\n• `/firstblood` - See first blood achievements",
							inline: false,
						},
					)
					.setFooter({ text: "Keep Hunting " });

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "previous": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: "No team exists in this channel.",
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: "You are not a member of this team.",
						ephemeral: true,
					});
				}

				const completedStmt = db.prepare(
					"SELECT * FROM team_completed_levels WHERE team_id = ? ORDER BY completed_at ASC",
				);
				const completedLevels = completedStmt.all(team.team_id) || [];

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

				const maxLength = 4096;
				const currentText = levelTexts.join("\n\n");

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

					embed.setDescription(chunks[0]);
					await interaction.reply({ embeds: [embed], ephemeral: true });

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
		}
	} catch (error) {
		console.error(`Error in ${commandName} command:`, error);

		if (!interaction.replied && !interaction.deferred) {
			try {
				await interaction.reply({
					content:
						"An error occurred while processing your command. Please try again.",
					ephemeral: true,
				});
			} catch (replyError) {
				console.error("Error sending error reply:", replyError);
			}
		}
	}
});

client.on("error", (error) => {
	console.error("Discord client error:", error);
});

process.on("SIGINT", () => {
	console.log("Received SIGINT, shutting down...");
	db.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("Received SIGTERM, shutting down...");
	db.close();
	process.exit(0);
});

client.login(process.env.DISCORD_TOKEN || config.token);
