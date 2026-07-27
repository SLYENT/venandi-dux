const { SlashCommandBuilder, PermissionFlagsBits } = require("discord.js");
const { commandText } = require("./lib/text");

function buildCommands() {
	return [
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
}

module.exports = {
	buildCommands,
};