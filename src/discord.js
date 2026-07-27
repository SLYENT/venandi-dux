const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const config = require("../config.json");
const { colors, emojis, t } = require("./lib/text");

function getDiscordChannelUrl(guildId, channelId) {
	return `https://discord.com/channels/${guildId}/${channelId}`;
}

function getDiscordMessageUrl(guildId, channelId, messageId) {
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function createDiscordServices(client, dbHelpers, huntData) {
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
		const pointsAfterHint = Math.floor(level.points * (1 - config.hunt.hintPenalty));

		const embed = new EmbedBuilder()
			.setTitle(t("messages.hintRequestTitle", { teamName: team.team_name }))
			.setColor(colors.hint)
			.setDescription(requestMessage)
			.addFields(
				{ name: t("messages.hintRequestTeam"), value: `${team.team_name} (${team.team_id})`, inline: true },
				{ name: t("messages.hintRequestLevel"), value: level.id.toString(), inline: true },
				{ name: t("messages.hintRequestRequester"), value: `${requester.tag} (<@${requester.id}>)`, inline: false },
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
			.setFooter({ text: t("messages.hintRequestRequestedBy", { tag: requester.tag }) })
			.setTimestamp();

		await hintChannel.send({ embeds: [embed] });
		return true;
	}

	function isWhitelistedChannel(channelId) {
		return config.whitelistedChannels.includes(channelId);
	}

	function isAdmin(interaction) {
		if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
			return true;
		}
		const userRoles = interaction.member.roles.cache.map((role) => role.name);
		return config.admin.roles.some((adminRole) => userRoles.includes(adminRole));
	}

	async function announceFirstBlood(levelId, teamName, completedBy, points) {
		if (!config.logging.firstBloodChannelId) return;

		const embed = new EmbedBuilder()
			.setTitle(`${emojis.firstBlood} FIRST BLOOD! ${emojis.firstBlood}`)
			.setDescription(t("messages.firstBloodAnnouncementDescription", { teamName, levelId }))
			.setColor(colors.danger)
			.addFields(
				{ name: t("messages.firstBloodAnsweredBy"), value: completedBy, inline: true },
				{ name: t("messages.firstBloodPointsEarned"), value: points.toString(), inline: true },
				{ name: t("messages.firstBloodLevel"), value: levelId.toString(), inline: true },
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

	async function logAttemptToChannel(
		teamName,
		username,
		levelId,
		answer,
		isCorrect,
		channelId,
	) {
		if (!config.logging.attemptChannelId) return;

		const color = isCorrect ? colors.success : colors.danger;

		const embed = new EmbedBuilder()
			.setTitle(isCorrect ? t("messages.attemptTitleCorrect") : t("messages.attemptTitleIncorrect"))
			.setColor(color)
			.addFields(
				{ name: t("messages.attemptTeam"), value: teamName, inline: true },
				{ name: t("messages.attemptPlayer"), value: username, inline: true },
				{ name: t("messages.progressLevel"), value: levelId.toString(), inline: true },
				{ name: t("messages.attemptAnswer"), value: `"${answer}"`, inline: false },
				{ name: t("messages.attemptChannel"), value: `<#${channelId}>`, inline: true },
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

	async function postAndPinLevel(channelId, levelData, teamName, teamPoints) {
		try {
			const channel = await client.channels.fetch(channelId);
			if (!channel?.isTextBased()) return;

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
				.setTitle(t("messages.levelTitle", { levelId: levelData.id, levelName: levelData.levelname || "Unnamed Level" }))
				.setDescription(levelData.question)
				.setColor(colors.level)
				.addFields(
					{ name: t("messages.questionPoints"), value: levelData.points.toString(), inline: true },
					{ name: t("messages.teamPoints"), value: teamPoints.toString(), inline: true },
				)
				.setFooter({ text: t("messages.levelFooter") })
				.setTimestamp();

			if (levelData.image) {
				embed.setImage(levelData.image);
			}

			const message = await channel.send({
				content: t("messages.levelAdvanceContent", { teamName, levelId: levelData.id }),
				embeds: [embed],
			});

			await message.pin();
			return message;
		} catch (error) {
			console.error("Error posting and pinning level:", error);
		}
	}

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
					{ name: t("messages.completionFinalScore"), value: `${totalPoints} points`, inline: true },
					{ name: t("messages.completionLevelsCompleted"), value: `${completedLevels}/${totalLevels}`, inline: true },
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
				{ name: t("messages.progressSolvedBy"), value: completedBy, inline: true },
				{ name: t("messages.progressPointsEarned"), value: pointsEarned.toString(), inline: true },
				{ name: t("messages.progressTotalPoints"), value: totalPoints.toString(), inline: true },
				{ name: t("messages.progressLevel"), value: levelId.toString(), inline: true },
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

	return {
		isWhitelistedChannel,
		isAdmin,
		sendHintRequest,
		announceFirstBlood,
		logAttemptToChannel,
		postAndPinLevel,
		sendCompletionCelebration,
		sendProgressUpdate,
	};
}

module.exports = {
	createDiscordServices,
};