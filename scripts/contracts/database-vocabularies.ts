import type postgres from "postgres";

import {
	type CheckConstraintRow,
	type CheckVocabulary,
	parseCheckVocabulary,
} from "./database-check-parser.ts";
import {
	type ContractFileMap,
	GENERATED_HEADER,
	pascalCase,
} from "./database-types.ts";

export {
	type CheckConstraintRow,
	type CheckVocabulary,
	parseCheckVocabulary,
} from "./database-check-parser.ts";

const GENERATED_VOCABULARY_DIRECTORY =
	"packages/contracts/src/runtime/generated/db-vocabularies";
const VOCABULARIES_PER_PART = 10;

function constantName(vocabulary: CheckVocabulary): string {
	return `${vocabulary.schema}_${vocabulary.table}_${vocabulary.column}_values`
		.replace(/[^a-zA-Z0-9]+/gu, "_")
		.toUpperCase();
}

function typeName(vocabulary: CheckVocabulary): string {
	return pascalCase(
		`${vocabulary.schema}_${vocabulary.table}_${vocabulary.column}`,
	);
}

export async function readCheckVocabularies(
	sql: postgres.Sql,
): Promise<CheckVocabulary[]> {
	const rows = await sql<CheckConstraintRow[]>`
    select
      namespace.nspname as schema_name,
      relation.relname as table_name,
      attribute.attname as column_name,
      constraint_record.conname as constraint_name,
      pg_get_expr(constraint_record.conbin, constraint_record.conrelid) as definition
    from pg_constraint as constraint_record
    join pg_class as relation
      on relation.oid = constraint_record.conrelid
    join pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    join pg_attribute as attribute
      on attribute.attrelid = constraint_record.conrelid
      and attribute.attnum = constraint_record.conkey[1]
    where constraint_record.contype = 'c'
      and cardinality(constraint_record.conkey) = 1
      and namespace.nspname in ('public', 'shipbash_private')
    order by
      namespace.nspname,
      relation.relname,
      attribute.attname,
      constraint_record.conname
  `;

	return rows
		.map(parseCheckVocabulary)
		.filter((value): value is CheckVocabulary => value !== null);
}

function javascriptDeclarations(vocabularies: CheckVocabulary[]): string[] {
	return vocabularies.map(
		(vocabulary) =>
			`export const ${constantName(vocabulary)} = Object.freeze(${JSON.stringify(vocabulary.values)});`,
	);
}

function javascriptCatalog(vocabularies: CheckVocabulary[]): string[] {
	return vocabularies.map((vocabulary) => {
		return `  Object.freeze({ schema: ${JSON.stringify(vocabulary.schema)}, table: ${JSON.stringify(vocabulary.table)}, column: ${JSON.stringify(vocabulary.column)}, constraint: ${JSON.stringify(vocabulary.constraint)}, values: ${constantName(vocabulary)} }),`;
	});
}

function javascriptPartModule(vocabularies: CheckVocabulary[]): string {
	const declarations = javascriptDeclarations(vocabularies);
	const catalog = javascriptCatalog(vocabularies);
	return `${GENERATED_HEADER}${declarations.join("\n")}\n\nconst databaseCheckVocabularies = Object.freeze([\n${catalog.join("\n")}\n]);\n\nexport default databaseCheckVocabularies;\n`;
}

function vocabularyPartName(index: number): string {
	return `part-${String(index + 1).padStart(2, "0")}`;
}

function vocabularyPartIdentifier(index: number): string {
	return `vocabularyPart${String(index + 1).padStart(2, "0")}`;
}

function javascriptIndexModule(partNames: string[]): string {
	const imports = partNames.map(
		(partName, index) =>
			`import ${vocabularyPartIdentifier(index)} from "./db-vocabularies/${partName}.mjs";`,
	);
	const exports = partNames.map(
		(partName) => `export * from "./db-vocabularies/${partName}.mjs";`,
	);
	const catalog = partNames.map(
		(_partName, index) => `  ...${vocabularyPartIdentifier(index)},`,
	);
	return `${GENERATED_HEADER}${imports.join("\n")}\n\n${exports.join("\n")}\n\nexport const DATABASE_CHECK_VOCABULARIES = Object.freeze([\n${catalog.join("\n")}\n]);\n`;
}

function declarationPartModule(vocabularies: CheckVocabulary[]): string {
	const declarations = vocabularies.map((vocabulary) => {
		const tuple = `[${vocabulary.values.map((value) => JSON.stringify(value)).join(", ")}]`;
		const name = constantName(vocabulary);
		return `export declare const ${name}: readonly ${tuple};\nexport type ${typeName(vocabulary)} = (typeof ${name})[number];`;
	});
	return `${GENERATED_HEADER}${declarations.join("\n")}\n\ninterface DatabaseCheckVocabularyPart {\n  readonly schema: string;\n  readonly table: string;\n  readonly column: string;\n  readonly constraint: string;\n  readonly values: readonly (string | number)[];\n}\n\ndeclare const databaseCheckVocabularies: readonly DatabaseCheckVocabularyPart[];\nexport default databaseCheckVocabularies;\n`;
}

function declarationIndexModule(partNames: string[]): string {
	const exports = partNames.map(
		(partName) => `export * from "./db-vocabularies/${partName}.mjs";`,
	);
	return `${GENERATED_HEADER}${exports.join("\n")}\n\nexport interface DatabaseCheckVocabulary {\n  readonly schema: string;\n  readonly table: string;\n  readonly column: string;\n  readonly constraint: string;\n  readonly values: readonly (string | number)[];\n}\n\nexport declare const DATABASE_CHECK_VOCABULARIES: readonly DatabaseCheckVocabulary[];\n`;
}

function vocabularyParts(vocabularies: CheckVocabulary[]): CheckVocabulary[][] {
	return Array.from(
		{ length: Math.ceil(vocabularies.length / VOCABULARIES_PER_PART) },
		(_value, index) =>
			vocabularies.slice(
				index * VOCABULARIES_PER_PART,
				(index + 1) * VOCABULARIES_PER_PART,
			),
	);
}

export function generateVocabularyFiles(
	vocabularies: CheckVocabulary[],
): ContractFileMap {
	const parts = vocabularyParts(vocabularies);
	const partNames = parts.map((_part, index) => vocabularyPartName(index));
	const files: ContractFileMap = new Map([
		[
			"packages/contracts/src/runtime/generated/db-vocabularies.mjs",
			javascriptIndexModule(partNames),
		],
		[
			"packages/contracts/src/runtime/generated/db-vocabularies.d.mts",
			declarationIndexModule(partNames),
		],
	]);

	for (const [index, part] of parts.entries()) {
		const path = `${GENERATED_VOCABULARY_DIRECTORY}/${vocabularyPartName(index)}`;
		files.set(`${path}.mjs`, javascriptPartModule(part));
		files.set(`${path}.d.mts`, declarationPartModule(part));
	}

	return files;
}
