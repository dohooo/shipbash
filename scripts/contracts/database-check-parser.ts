import type postgres from "postgres";

/**
 * Parse PostgreSQL-normalized CHECK expressions into literal vocabularies.
 * ARRAY, singleton, nullable, cast, and quoted-string forms share this scanner
 * so expression-derived pseudo vocabularies are rejected consistently.
 */

export interface CheckConstraintRow extends postgres.Row {
	schema_name: string;
	table_name: string;
	column_name: string;
	constraint_name: string;
	definition: string;
}

export interface CheckVocabulary {
	schema: string;
	table: string;
	column: string;
	constraint: string;
	values: ReadonlyArray<string | number>;
}

function skipWhitespace(source: string, start: number): number {
	let cursor = start;
	while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
	return cursor;
}

function skipCast(source: string, start: number): number {
	let cursor = skipWhitespace(source, start);
	if (source.slice(cursor, cursor + 2) !== "::") return cursor;
	cursor = skipWhitespace(source, cursor + 2);
	const match = source
		.slice(cursor)
		.match(/^[a-zA-Z_][a-zA-Z0-9_.]*(?:\s+varying)?/u);
	if (!match) throw new Error(`Unsupported CHECK cast in ${source}.`);
	return cursor + match[0].length;
}

function parseStringConstant(
	source: string,
	start: number,
): { next: number; value: string } {
	let cursor = start + 1;
	let value = "";
	while (cursor < source.length) {
		if (source[cursor] !== "'") {
			value += source[cursor];
			cursor += 1;
			continue;
		}
		if (source[cursor + 1] === "'") {
			value += "'";
			cursor += 2;
			continue;
		}
		return { next: skipCast(source, cursor + 1), value };
	}
	throw new Error(`Unterminated CHECK string in ${source}.`);
}

function parseIntegerConstant(
	source: string,
	start: number,
): { next: number; value: number } {
	const match = source.slice(start).match(/^-?\d+/u);
	if (!match) throw new Error(`Unsupported CHECK value in ${source}.`);
	const value = Number(match[0]);
	if (!Number.isSafeInteger(value)) {
		throw new Error(`Unsafe CHECK integer in ${source}.`);
	}
	return { next: skipCast(source, start + match[0].length), value };
}

function parseConstant(
	source: string,
	start: number,
): { next: number; value: string | number } | null {
	const cursor = skipWhitespace(source, start);
	if (source[cursor] === "'") return parseStringConstant(source, cursor);
	if (/[-\d]/u.test(source[cursor] ?? "")) {
		return parseIntegerConstant(source, cursor);
	}
	return null;
}

function parseArrayConstants(source: string): Array<string | number> {
	const values: Array<string | number> = [];
	let cursor = skipWhitespace(source, 0);
	while (cursor < source.length) {
		const parsed = parseConstant(source, cursor);
		if (!parsed)
			throw new Error(`Unsupported CHECK value in ARRAY[${source}].`);
		values.push(parsed.value);
		cursor = skipWhitespace(source, parsed.next);
		if (cursor >= source.length) break;
		if (source[cursor] !== ",") {
			throw new Error(`Unexpected CHECK token in ARRAY[${source}].`);
		}
		cursor = skipWhitespace(source, cursor + 1);
	}
	if (values.length === 0) throw new Error("CHECK vocabulary cannot be empty.");
	return values;
}

function outerParenthesesWrapWholeExpression(source: string): boolean {
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < source.length; index += 1) {
		const character = source[index];
		if (character === "'") {
			if (quoted && source[index + 1] === "'") index += 1;
			else quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (character === "(") depth += 1;
		else if (character === ")") depth -= 1;
		if (depth === 0 && index < source.length - 1) return false;
	}
	return depth === 0 && !quoted;
}

function stripOuterParentheses(source: string): string {
	let result = source.trim();
	while (
		result.startsWith("(") &&
		result.endsWith(")") &&
		outerParenthesesWrapWholeExpression(result)
	) {
		result = result.slice(1, -1).trim();
	}
	return result;
}

function splitTopLevelOr(source: string): [string, string] | null {
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < source.length - 1; index += 1) {
		const character = source[index];
		if (character === "'") {
			if (quoted && source[index + 1] === "'") index += 1;
			else quoted = !quoted;
			continue;
		}
		if (quoted) continue;
		if (character === "(") depth += 1;
		else if (character === ")") depth -= 1;
		else if (
			depth === 0 &&
			source.slice(index, index + 2).toUpperCase() === "OR" &&
			/\s/u.test(source[index - 1] ?? "") &&
			/\s/u.test(source[index + 2] ?? "")
		) {
			return [source.slice(0, index), source.slice(index + 2)];
		}
	}
	return null;
}

function escapedColumn(column: string): string {
	return column.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseDirectEquality(
	source: string,
	column: string,
): string | number | null {
	const expression = stripOuterParentheses(source);
	const match = expression.match(
		new RegExp(`^"?${escapedColumn(column)}"?\\s*=\\s*`, "u"),
	);
	if (!match) return null;
	const parsed = parseConstant(expression, match[0].length);
	if (
		!parsed ||
		skipWhitespace(expression, parsed.next) !== expression.length
	) {
		return null;
	}
	return parsed.value;
}

function isDirectNullCheck(source: string, column: string): boolean {
	return new RegExp(`^"?${escapedColumn(column)}"?\\s+IS\\s+NULL$`, "iu").test(
		stripOuterParentheses(source),
	);
}

function parseSingleValueVocabulary(
	row: CheckConstraintRow,
): CheckVocabulary | null {
	const expression = stripOuterParentheses(row.definition);
	let value = parseDirectEquality(expression, row.column_name);
	if (value === null) {
		const alternatives = splitTopLevelOr(expression);
		if (!alternatives) return null;
		const [left, right] = alternatives;
		if (isDirectNullCheck(left, row.column_name)) {
			value = parseDirectEquality(right, row.column_name);
		} else if (isDirectNullCheck(right, row.column_name)) {
			value = parseDirectEquality(left, row.column_name);
		}
	}
	return value === null
		? null
		: {
				schema: row.schema_name,
				table: row.table_name,
				column: row.column_name,
				constraint: row.constraint_name,
				values: [value],
			};
}

export function parseCheckVocabulary(
	row: CheckConstraintRow,
): CheckVocabulary | null {
	const candidate = /=\s*ANY\s*\(\s*ARRAY\[/iu;
	if (!candidate.test(row.definition)) return parseSingleValueVocabulary(row);

	const definition = stripOuterParentheses(row.definition);
	const alternatives = splitTopLevelOr(definition);
	let expression = definition;
	if (alternatives) {
		const [left, right] = alternatives;
		if (isDirectNullCheck(left, row.column_name)) {
			expression = stripOuterParentheses(right);
		} else if (isDirectNullCheck(right, row.column_name)) {
			expression = stripOuterParentheses(left);
		} else {
			const arrayCount = [...definition.matchAll(/=\s*ANY\s*\(\s*ARRAY\[/giu)]
				.length;
			throw new Error(
				arrayCount === 1
					? `CHECK ${row.constraint_name} ARRAY vocabulary must be a direct comparison or nullable wrapper.`
					: `CHECK ${row.constraint_name} contains an ambiguous ARRAY vocabulary.`,
			);
		}
	}

	const matches = [
		...expression.matchAll(/=\s*ANY\s*\(\s*ARRAY\[([\s\S]*?)\]\s*\)/giu),
	];
	if (matches.length !== 1 || matches[0]?.[1] === undefined) {
		throw new Error(
			`CHECK ${row.constraint_name} contains an ambiguous ARRAY vocabulary.`,
		);
	}
	const prefix = expression.slice(0, matches[0].index);
	const suffix = expression.slice(
		(matches[0].index ?? 0) + matches[0][0].length,
	);
	const directColumnPattern = new RegExp(
		`^\\s*"?${escapedColumn(row.column_name)}"?\\s*$`,
		"u",
	);
	if (!directColumnPattern.test(prefix)) {
		throw new Error(
			`CHECK ${row.constraint_name} does not compare ${row.column_name} directly.`,
		);
	}
	if (suffix.trim() !== "") {
		throw new Error(
			`CHECK ${row.constraint_name} contains an additional expression after its ARRAY vocabulary.`,
		);
	}
	return {
		schema: row.schema_name,
		table: row.table_name,
		column: row.column_name,
		constraint: row.constraint_name,
		values: parseArrayConstants(matches[0][1]),
	};
}
