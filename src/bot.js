const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	SlashCommandBuilder,
	PermissionFlagsBits,
} = require("discord.js");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.json");
const { copy, commandText, colors, emojis, t } = require("./lib/text");
const Database = require("better-sqlite3");

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function ensureDataDirectory() {
	const dataDir = path.join(__dirname, "..", "data");
	if (!fs.existsSync(dataDir)) {
		fs.mkdirSync(dataDir, { recursive: true });
		console.log(t("system.createdDataDirectory"));
	}
}

ensureDataDirectory();
const db = new Database(path.join(__dirname, "..", "data", "hunt.db"));

// optimize performance
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

console.log(t("system.dbInitialized"));

// load hunt data
let huntData;
try {
	huntData = require("../hunt.json");
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

console.log(t("system.tablesVerified"));

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

function getDiscordChannelUrl(guildId, channelId) {
	return `https://discord.com/channels/${guildId}/${channelId}`;
}

function getDiscordMessageUrl(guildId, channelId, messageId) {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
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

async function sendHintRequest({
	team,
	level,
	requester,
	requestMessage,
	sourceChannelId,
	sourceMessageId,
	guildId,
}) {
	if (!config.logging.hintRequestChannelId) {
		return false;
	}

	const hintChannel = await client.channels.fetch(
		config.logging.hintRequestChannelId,
	);

	if (!hintChannel?.isTextBased()) {
		return false;
	}

	const sourceChannelUrl = getDiscordChannelUrl(guildId, sourceChannelId);
	const sourceMessageUrl = getDiscordMessageUrl(
		guildId,
		sourceChannelId,
		sourceMessageId,
	);
	const pointsAfterHint = Math.floor(
		level.points * (1 - config.hunt.hintPenalty),
	);

	const embed = new EmbedBuilder()
		.setTitle(t("messages.hintRequestTitle", { teamName: team.team_name }))
		.setColor(colors.hint)
		.setDescription(requestMessage)
		.addFields(
			{
				name: t("messages.hintRequestTeam"),
				value: `${team.team_name} (${team.team_id})`,
				inline: true,
			},
			{
				name: t("messages.hintRequestLevel"),
				value: level.id.toString(),
				inline: true,
			},
			{
				name: t("messages.hintRequestRequester"),
				value: `${requester.tag} (<@${requester.id}>)`,
				inline: false,
			},
			{
				name: t("messages.hintRequestSourceChannel"),
				value: `<#${sourceChannelId}>\n[Open Channel](${sourceChannelUrl})`,
				inline: false,
			},
			{
				name: t("messages.hintRequestMessage"),
				value: `[Open Message](${sourceMessageUrl})`,
				inline: false,
			},
			{
				name: t("messages.hintRequestCost"),
				value: `25% penalty | ${pointsAfterHint} points remain on solve`,
				inline: true,
			},
		)
		.setFooter({
			text: t("messages.hintRequestRequestedBy", { tag: requester.tag }),
		})
		.setTimestamp();

	await hintChannel.send({ embeds: [embed] });
	return true;
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
		.setTitle(`${emojis.firstBlood} FIRST BLOOD! ${emojis.firstBlood}`)
		.setDescription(
			t("messages.firstBloodAnnouncementDescription", { teamName, levelId }),
		)
		.setColor(colors.danger)
		.addFields(
			{
				name: t("messages.firstBloodAnsweredBy"),
				value: completedBy,
				inline: true,
			},
			{
				name: t("messages.firstBloodPointsEarned"),
				value: points.toString(),
				inline: true,
			},
			{
				name: t("messages.firstBloodLevel"),
				value: levelId.toString(),
				inline: true,
			},
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
	const color = isCorrect ? colors.success : colors.danger;

	const embed = new EmbedBuilder()
		.setTitle(
			isCorrect
				? t("messages.attemptTitleCorrect")
				: t("messages.attemptTitleIncorrect"),
		)
		.setColor(color)
		.addFields(
			{ name: t("messages.attemptTeam"), value: teamName, inline: true },
			{ name: t("messages.attemptPlayer"), value: username, inline: true },
			{
				name: t("messages.progressLevel"),
				value: levelId.toString(),
				inline: true,
			},
			{
				name: t("messages.attemptAnswer"),
				value: `"${answer}"`,
				inline: false,
			},
			{
				name: t("messages.attemptChannel"),
				value: `<#${channelId}>`,
				inline: true,
			},
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
				t("messages.levelTitle", {
					levelId: levelData.id,
					levelName: levelData.levelname || "Unnamed Level",
				}),
			)
			.setDescription(levelData.question)
			.setColor(colors.level)
			.addFields(
				{
					name: t("messages.questionPoints"),
					value: levelData.points.toString(),
					inline: true,
				},
				{
					name: t("messages.teamPoints"),
					value: teamPoints.toString(),
					inline: true,
				},
			)
			.setFooter({ text: t("messages.levelFooter") })
			.setTimestamp();

		if (levelData.image) {
			embed.setImage(levelData.image);
		}

		const message = await channel.send({
			content: t("messages.levelAdvanceContent", {
				teamName,
				levelId: levelData.id,
			}),
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
			.setTitle(t("messages.completionTitle"))
			.setDescription(t("messages.completionDescription", { teamName }))
			.setColor(colors.leaderboard)
			.addFields(
				{
					name: t("messages.completionFinalScore"),
					value: `${totalPoints} points`,
					inline: true,
				},
				{
					name: t("messages.completionLevelsCompleted"),
					value: `${completedLevels}/${totalLevels}`,
					inline: true,
				},
			)
			.setFooter({ text: t("messages.completionFooter") })
			.setTimestamp();

		await channel.send({
			content: `🎉*${t("messages.completion")}`,
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
		.setTitle(t("messages.progressTitle"))
		.setDescription(t("messages.progressDescription", { teamName, levelId }))
		.setColor(isFirstBlood ? colors.danger : colors.success)
		.addFields(
			{
				name: t("messages.progressSolvedBy"),
				value: completedBy,
				inline: true,
			},
			{
				name: t("messages.progressPointsEarned"),
				value: pointsEarned.toString(),
				inline: true,
			},
			{
				name: t("messages.progressTotalPoints"),
				value: totalPoints.toString(),
				inline: true,
			},
			{
				name: t("messages.progressLevel"),
				value: levelId.toString(),
				inline: true,
			},
		)
		.setTimestamp();

	if (isFirstBlood) {
		embed.addFields({
			name: t("messages.progressAchievement"),
			value: t("messages.progressFirstBlood"),
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
			.setDescription(commandText.createteam.description)
			.addStringOption((option) =>
				option
					.setName("name")
					.setDescription(commandText.createteam.nameOption)
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("jointeam")
			.setDescription(commandText.jointeam.description),

		new SlashCommandBuilder()
			.setName("teaminfo")
			.setDescription(commandText.teaminfo.description),

		new SlashCommandBuilder()
			.setName("hunt")
			.setDescription(commandText.hunt.description),

		new SlashCommandBuilder()
			.setName("answer")
			.setDescription(commandText.answer.description)
			.addStringOption((option) =>
				option
					.setName("solution")
					.setDescription(commandText.answer.solutionOption)
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("leaderboard")
			.setDescription(commandText.leaderboard.description),

		new SlashCommandBuilder()
			.setName("hint")
			.setDescription(commandText.hint.description)
			.addStringOption((option) =>
				option
					.setName("message")
					.setDescription(commandText.hint.messageOption)
					.setRequired(true),
			),

		new SlashCommandBuilder()
			.setName("resethunt")
			.setDescription(commandText.resethunt.description)
			.addStringOption((option) =>
				option
					.setName("confirm")
					.setDescription(commandText.resethunt.confirmOption)
					.setRequired(true),
			)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("help")
			.setDescription(commandText.help.description),

		new SlashCommandBuilder()
			.setName("previous")
			.setDescription(commandText.previous.description),

		new SlashCommandBuilder()
			.setName("adminprogress")
			.setDescription(commandText.adminprogress.description)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("adminattempts")
			.setDescription(commandText.adminattempts.description)
			.addIntegerOption((option) =>
				option
					.setName("limit")
					.setDescription(commandText.adminattempts.limitOption)
					.setMinValue(1)
					.setMaxValue(50),
			)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("firstblood")
			.setDescription(commandText.firstblood.description),

		new SlashCommandBuilder()
			.setName("adminfirstblood")
			.setDescription(commandText.adminfirstblood.description)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("adminaddpoints")
			.setDescription(commandText.adminaddpoints.description)
			.addIntegerOption((option) =>
				option
					.setName("points")
					.setDescription(commandText.adminaddpoints.pointsOption)
					.setRequired(true)
					.setMinValue(1),
			)
			.addStringOption((option) =>
				option
					.setName("team")
					.setDescription(commandText.adminaddpoints.teamOption)
					.setRequired(true),
			)
			.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

		new SlashCommandBuilder()
			.setName("adminremovepoints")
			.setDescription(commandText.adminremovepoints.description)
			.addIntegerOption((option) =>
				option
					.setName("points")
					.setDescription(commandText.adminremovepoints.pointsOption)
					.setRequired(true)
					.setMinValue(1),
			)
			.addStringOption((option) =>
				option
					.setName("team")
					.setDescription(commandText.adminremovepoints.teamOption)
					.setRequired(true),
			)
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
			content: copy.commandRestricted,
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
						content: copy.teamNameTooLongShort,
						ephemeral: true,
					});
				}

				const existingTeam = getTeamByChannel(interaction.channelId);
				if (existingTeam) {
					return interaction.reply({
						content: copy.teamAlreadyExistsShort,
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
					content: t("messages.teamCreatedMessage", { teamName }),
					ephemeral: false,
				});
			}

			case "jointeam": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: copy.noTeamCreate,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: copy.alreadyMemberShort,
						ephemeral: true,
					});
				}

				if (members.length >= config.hunt.maxTeamSize) {
					return interaction.reply({
						content: t("messages.teamFullLong", {
							maxTeamSize: config.hunt.maxTeamSize,
						}),
						ephemeral: true,
					});
				}

				addTeamMember(team.team_id, userId, username);

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				let welcomeMessage = t("messages.joinedTeamMessage", {
					username,
					teamName: team.team_name,
				});

				if (currentLevel) {
					welcomeMessage += t("messages.workingOnLevelMessage", {
						level: team.level,
					});
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
						content: copy.teamNotInChannel,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				const memberList = members.map((m) => m.username).join(", ");

				const embed = new EmbedBuilder()
					.setTitle(
						t("messages.teamInfoTitleCustom", { teamName: team.team_name }),
					)
					.setColor(colors.info)
					.addFields(
						{
							name: t("messages.membersLabel"),
							value: memberList || copy.teamInfoNone,
						},
						{
							name: t("messages.currentLevelLabel"),
							value: team.level.toString(),
						},
						{ name: t("messages.pointsLabel"), value: team.points.toString() },
						{
							name: t("messages.teamSizeLabel"),
							value: `${members.length}/${config.hunt.maxTeamSize}`,
						},
					);

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "adminprogress": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content: copy.noPermissionCommand,
						ephemeral: true,
					});
				}

				const allTeams = getAllTeamsProgress();
				if (allTeams.length === 0) {
					return interaction.reply({
						content: copy.noTeamsYet,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(t("messages.adminProgressTitle"))
					.setColor(colors.danger);

				const progressText = allTeams
					.map((team, index) => {
						const lastCompleted = team.last_completed
							? new Date(team.last_completed).toLocaleString()
							: copy.lastActivityNever;
						return t("messages.adminProgressEntry", {
							rank: index + 1,
							teamName: team.team_name,
							memberCount: team.member_count,
							completedLevels: team.level - 1,
							points: team.points,
							lastActivity: lastCompleted,
							channelId: team.channel_id,
						});
					})
					.join("\n");

				if (progressText.length > 4096) {
					const chunks = progressText.match(/.{1,4000}/g) || [];
					for (let i = 0; i < chunks.length; i++) {
						const chunkEmbed = new EmbedBuilder()
							.setTitle(
								i === 0
									? copy.adminProgressTitle
									: t("messages.adminProgressTitlePaged", { page: i + 1 }),
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
						content: copy.noAttemptsYet,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(
						t("messages.adminAttemptsTitle", { count: attempts.length }),
					)
					.setColor(colors.warning);

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
						content: copy.noFirstBloodYet,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(t("messages.firstBloodHallTitle"))
					.setColor(colors.danger)
					.setDescription(t("messages.firstBloodHallDescription"));

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
						content: copy.noPermissionCommand,
						ephemeral: true,
					});
				}

				const firstBloodStats = getFirstBloodStats();
				if (firstBloodStats.length === 0) {
					return interaction.reply({
						content: copy.noFirstBloodYet,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(t("messages.adminFirstBloodTitleCustom"))
					.setColor(colors.danger);

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

			case "adminaddpoints":
			case "adminremovepoints": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content: copy.noPermissionCommand,
						ephemeral: true,
					});
				}

				const points = interaction.options.getInteger("points");
				const teamQuery = interaction.options.getString("team").trim();
				const team = db
					.prepare("SELECT * FROM teams WHERE team_id = ? OR team_name = ?")
					.get(teamQuery, teamQuery);

				if (!team) {
					return interaction.reply({
						content: t("messages.noTeamFound", { teamQuery }),
						ephemeral: true,
					});
				}

				const delta = commandName === "adminaddpoints" ? points : -points;
				const newPoints = Math.max(0, team.points + delta);
				updateTeamPoints(team.team_id, newPoints);
				team.points = newPoints;

				const action = delta > 0 ? "added to" : "subtracted from";
				return interaction.reply({
					content: t("messages.pointsUpdatedMessage", {
						points: Math.abs(delta),
						action,
						teamName: team.team_name,
						totalPoints: team.points,
					}),
					ephemeral: true,
				});
			}

			case "hunt": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: copy.noTeamCreate,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: copy.notMemberJoinShort,
						ephemeral: true,
					});
				}

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				if (!currentLevel) {
					return interaction.reply({
						content: copy.levelCompletedUnknown,
						ephemeral: true,
					});
				}

				await interaction.reply({
					content: copy.huntRepostNotice,
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
					await channel.send(copy.huntRepostedNotice);
				}
				break;
			}

			case "answer": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: copy.teamNotInChannel,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: copy.notMemberShort,
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
						content: copy.completedAllLevels,
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

					let successMessage = t("messages.successCorrect", {
						teamName: team.team_name,
						username,
						pointsEarned,
					});

					if (isFirstBlood) {
						successMessage += t("messages.successFirstBlood");
						if (config.features?.firstBloodBonus) {
							successMessage += t("messages.successFirstBloodBonus");
						}
					}

					if (nextLevel) {
						successMessage += t("messages.successAdvanced", {
							levelId: nextLevel.id,
						});

						await interaction.reply({
							content: `${successMessage}${t("messages.successNextLevel")}`,
						});

						await postAndPinLevel(
							interaction.channelId,
							nextLevel,
							team.team_name,
							team.points,
						);

						const channel = await client.channels.fetch(interaction.channelId);
						if (channel?.isTextBased()) {
							await channel.send(copy.huntRepostedNotice);
						}
					} else {
						successMessage += t("messages.successComplete");

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
					const wrongMessages = [copy.wrongAnswerA, copy.wrongAnswerB];
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
						content: copy.leaderboardNoTeams,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(copy.leaderboardTitle)
					.setColor(colors.leaderboard)
					.setDescription(copy.leaderboardDescription);

				const leaderboardText = leaderboard
					.map((team, index) => {
						const medal =
							index === 0
								? copy.leaderboardMedalFirst
								: index === 1
									? copy.leaderboardMedalSecond
									: index === 2
										? copy.leaderboardMedalThird
										: t("messages.leaderboardRank", { rank: index + 1 });
						const completedLevels = team.level - 1;
						const lastActivity = team.last_completed
							? new Date(team.last_completed).toLocaleString()
							: copy.noCompletionsYet;

						return `${medal} **${team.team_name}**\n${t("messages.leaderboardLevelLine", { completedLevels, points: team.points })}\n${t("messages.leaderboardLastActivityLine", { lastActivity })}\n`;
					})
					.join("\n");

				embed.setDescription(leaderboardText);
				embed.setFooter({ text: copy.leaderboardFooter });

				return interaction.reply({ embeds: [embed], ephemeral: false });
			}

			case "hint": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: copy.teamNotInChannel,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: copy.notMemberShort,
						ephemeral: true,
					});
				}

				const currentLevel = huntData.levels.find(
					(level) => level.id === team.level,
				);
				if (!currentLevel) {
					return interaction.reply({
						content: copy.noLevelMessage || copy.levelCompletedUnknown,
						ephemeral: true,
					});
				}

				if (team.hintUsed.includes(currentLevel.id)) {
					return interaction.reply({
						content: copy.hintAlreadyUsed,
						ephemeral: true,
					});
				}

				const requestMessage = interaction.options.getString("message").trim();
				if (requestMessage.length > 1000) {
					return interaction.reply({
						content: copy.hintTooLong,
						ephemeral: true,
					});
				}

				team.hintUsed.push(currentLevel.id);
				updateTeamProgress(team.team_id, team);

				const confirmationMessage = await interaction.reply({
					content: `${copy.hintRequestSubmittedShort}${t("messages.hintPenaltyNotice")}`,
					fetchReply: true,
				});

				try {
					const requestLogged = await sendHintRequest({
						team,
						level: currentLevel,
						requester: interaction.user,
						requestMessage,
						sourceChannelId: interaction.channelId,
						sourceMessageId: confirmationMessage.id,
						guildId: interaction.guildId,
					});

					if (requestLogged) {
						break;
					}
				} catch (error) {
					console.error("Failed to send hint request:", error);
				}

				team.hintUsed.pop();
				updateTeamProgress(team.team_id, team);

				return interaction.followUp({
					content: copy.hintRequestFailedShort,
					ephemeral: true,
				});
			}

			case "resethunt": {
				if (!isAdmin(interaction)) {
					return interaction.reply({
						content: copy.noPermissionCommand,
						ephemeral: true,
					});
				}

				const confirm = interaction.options.getString("confirm");
				if (confirm !== "RESET") {
					return interaction.reply({
						content: copy.resetConfirmShort,
						ephemeral: true,
					});
				}

				resetHuntDatabase();

				return interaction.reply({
					content: copy.resetSuccessShort,
					ephemeral: true,
				});
			}

			case "help": {
				const embed = new EmbedBuilder()
					.setTitle(copy.helpTitleCustom)
					.setColor(colors.info)
					.setDescription(copy.helpIntroCustom)
					.addFields(
						{
							name: copy.helpSectionStarted,
							value: t("messages.helpGettingStarted", {
								maxTeamSize: config.hunt?.maxTeamSize || 4,
							}),
							inline: false,
						},
						{
							name: copy.helpSectionPlay,
							value: copy.helpPlaying,
							inline: false,
						},
						{
							name: copy.helpSectionScore,
							value: copy.helpScoring,
							inline: false,
						},
						{
							name: copy.helpSectionTeam,
							value: copy.helpTeamCommands,
							inline: false,
						},
					)
					.setFooter({ text: copy.helpFooterCustom });

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			case "previous": {
				const team = getTeamByChannel(interaction.channelId);
				if (!team) {
					return interaction.reply({
						content: copy.teamNotInChannel,
						ephemeral: true,
					});
				}

				const members = getTeamMembers(team.team_id);
				if (!members.find((m) => m.user_id === userId)) {
					return interaction.reply({
						content: copy.notMemberShort,
						ephemeral: true,
					});
				}

				const completedStmt = db.prepare(
					"SELECT * FROM team_completed_levels WHERE team_id = ? ORDER BY completed_at ASC",
				);
				const completedLevels = completedStmt.all(team.team_id) || [];

				if (completedLevels.length === 0) {
					return interaction.reply({
						content: copy.previousNone,
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setTitle(t("messages.previousTitle", { teamName: team.team_name }))
					.setColor(colors.success)
					.setDescription(copy.previousDescription);

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
								t("messages.previousTitlePaged", {
									teamName: team.team_name,
									page: i + 1,
								}),
							)
							.setColor(colors.success)
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
