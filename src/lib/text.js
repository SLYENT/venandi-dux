const text = require("../../text.json");

function formatText(template, values = {}) {
	return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
		const value = values[key];
		return value === undefined || value === null ? "" : String(value);
	});
}

function t(key, values = {}) {
	const template = key.split(".").reduce((current, part) => current?.[part], text);
	if (typeof template === "string") {
		return formatText(template, values);
	}
	if (Array.isArray(template)) {
		return template.map((item) =>
			typeof item === "string" ? formatText(item, values) : item,
		);
	}
	return template;
}

module.exports = {
	text,
	copy: text.messages,
	commandText: text.commands,
	colors: text.colors,
	emojis: text.emojis,
	t,
};