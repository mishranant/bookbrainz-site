/*
 * Copyright (C) 2015       Ben Ockmore
 *               2015-2017  Sean Burke
 				 2019       Akhilesh Kumar (@akhilesh26)
 				 2020		Prabal Singh
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */

// @flow

import Promise from 'bluebird';
import _ from 'lodash';

/**
 * Returns an API path for interacting with the given Bookshelf entity model
 *
 * @param {object} entity - Entity object
 * @returns {string} - URL path to interact with entity
 */
export function getEntityLink(entity: Object): string {
	return `/${_.kebabCase(entity.type)}/${entity.bbid}`;
}

/**
 * Returns all entity models defined in bookbrainz-data-js
 *
 * @param {object} orm - the BookBrainz ORM, initialized during app setup
 * @returns {object} - Object mapping model name to the entity model
 */
export function getEntityModels(orm: Object): Object {
	const {Author, Edition, EditionGroup, Publisher, Work} = orm;
	return {
		Author,
		Edition,
		EditionGroup,
		Publisher,
		Work
	};
}
function getRevisionModels(orm) {
	const {AuthorRevision, EditionRevision, EditionGroupRevision, PublisherRevision, WorkRevision} = orm;
	return [
		AuthorRevision,
		EditionGroupRevision,
		EditionRevision,
		PublisherRevision,
		WorkRevision
	];
}
/* eslint-disable no-await-in-loop */
/**
 * Fetches the entities affected by a revision, their alias
 * or in case of deleted entities their last know alias.
 * It then attaches the necessary information to each revisions's entities array
 *
 * @param {array} revisions - the array of revisions
 * @param {object} orm - the BookBrainz ORM, initialized during app setup
 * @returns {array} - The modified revisions array
 */
export async function getAssociatedEntityRevisions(revisions, orm) {
	const revisionIDs = revisions.map(({revisionId}) => revisionId);
	const RevisionModels = getRevisionModels(orm);
	const {Entity} = orm;
	for (let i = 0; i < RevisionModels.length; i++) {
		const EntityRevision = RevisionModels[i];
		const entityRevisions = await new EntityRevision()
			.query((qb) => {
				qb.whereIn('id', revisionIDs);
			})
			.fetchAll({
				require: false,
				withRelated: [
					'data.aliasSet.defaultAlias'
				]
			})
			.catch(EntityRevision.NotFoundError, (err) => {
				// eslint-disable-next-line no-console
				console.log(err);
			});
		if (entityRevisions && entityRevisions.length) {
			const entityRevisionsJSON = entityRevisions.toJSON();
			for (let index = 0; index < entityRevisionsJSON.length; index++) {
				const entityRevision = entityRevisionsJSON[index];
				const entity = await new Entity({bbid: entityRevision.bbid}).fetch();
				const type = entity.get('type');
				const bbid = entity.get('bbid');
				const entityProps = {bbid, type};
				if (entityRevision.data) {
					entityProps.defaultAlias = entityRevision.data.aliasSet.defaultAlias;
				}
				// Fetch the parent alias only if data property is nullish, i.e. it is deleted
				else {
					entityProps.parentAlias = await orm.func.entity.getEntityParentAlias(orm, type, bbid);
				}
				// Find the revision by id and attach the current entity to it
				const revisionIndex = revisions.findIndex(rev => rev.revisionId === entityRevision.id);
				revisions[revisionIndex].entities.push(entityProps);
			}
		}
	}
	return revisions;
}
/* eslint-enable no-await-in-loop */

export async function getOrderedRevisions(from, size, orm) {
	const {Revision} = orm;
	const revisions = await new Revision().orderBy('created_at', 'DESC')
		.fetchPage({
			limit: size,
			offset: from,
			withRelated: [
				'author'
			]
		});
	const revisionsJSON = revisions.toJSON();

	/* Massage the revisions to match the expected format */
	const formattedRevisions = revisionsJSON.map(rev => {
		const {author: editor, id: revisionId, ...otherProps} = rev;
		return {editor, entities: [], revisionId, ...otherProps};
	});

	/* Fetch associated ${entity}_revisions and last know alias for deleted entities */
	const orderedRevisions = getAssociatedEntityRevisions(formattedRevisions, orm);
	return orderedRevisions;
}

export function getDateBeforeDays(days) {
	const date = new Date();
	date.setDate(date.getDate() - days);
	return date;
}

export function filterIdentifierTypesByEntityType(
	identifierTypes: Array<Object>,
	entityType: string
): Array<Object> {
	return identifierTypes.filter(
		(type) => type.entityType === entityType
	);
}

export function filterIdentifierTypesByEntity(
	identifierTypes: Array<Object>,
	entity: Object
): Array<Object> {
	const typesOnEntity = new Set();

	if (!entity.identifierSet || entity.identifierSet.identifiers.length < 1) {
		/*
		 * If there are no identifiers, skip the work of trying to add types
		 * which shouldn't be on this entity.
		 */
		return filterIdentifierTypesByEntityType(identifierTypes, entity.type);
	}

	for (const identifier of entity.identifierSet.identifiers) {
		typesOnEntity.add(identifier.type.id);
	}

	return identifierTypes.filter(
		(type) => type.entityType === entity.type || typesOnEntity.has(type.id)
	);
}

/**
 * Retrieves the Bookshelf entity model with the given the model name
 *
 * @param {object} orm - the BookBrainz ORM, initialized during app setup
 * @param {string} type - Name or type of model
 * @throws {Error} Throws a custom error if the param 'type' does not
 * map to a model
 * @returns {object} - Bookshelf model object with the type specified in the
 * single param
 */
export function getEntityModelByType(orm: Object, type: string): Object {
	const entityModels = getEntityModels(orm);

	if (!entityModels[type]) {
		throw new Error(`Unrecognized entity type: '${type}'`);
	}

	return entityModels[type];
}

/**
 * Helper-function / template-tag that allows the values of an object that
 * is passed in at a later time to be interpolated into a
 * string.
 *
 * Cribbed from MDN documentation on template literals:
 * https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Template_literals#Tagged_template_literals
 *
 * @param {string[]} strings - Array of string literals from template
 * @returns {function(*)} - Takes an object/array as an argument.
 * When invoked, it will return a string with all the key names from
 * the tagged template literal replaced with their corresponding values
 * from the newly passed in object.
 */
export function template(strings: Array<string>): Function {
	// eslint-disable-next-line prefer-reflect, prefer-rest-params
	const keys = Array.prototype.slice.call(arguments, 1);

	return (values): string => {
		const result = [strings[0]];

		keys.forEach((key, i) => {
			result.push(values[key], strings[i + 1]);
		});

		return result.join('');
	};
}

/**
 * Generates a page title for an entity row
 *
 * @param {object} entity - Entity object
 * @param {string} titleForUnnamed - Fallback title in case entity has no name
 * @param {function} templateForNamed - Accepts an object with a name field and
 * uses it to generate a title string
 * @returns {string} - Title string
 */
export function createEntityPageTitle(
	entity: Object,
	titleForUnnamed: string,
	templateForNamed: Function
): string {
	/**
	 * User-visible strings should _never_ be created by concatenation; when we
	 * start to implement localization, it will create problems for users of
	 * many languages. This helper is here to make it a little easier to do the
	 * right thing.
	 */
	let title = titleForUnnamed;

	// Accept template with a "name" replacement field
	if (entity && entity.defaultAlias && entity.defaultAlias.name) {
		title = templateForNamed({name: entity.defaultAlias.name});
	}

	return title;
}

/**
 * Adds 1 to the edit count of the specified editor
 *
 * @param {object} orm - the BookBrainz ORM, initialized during app setup
 * @param {string} id - row ID of editor to be updated
 * @param {object} transacting - Bookshelf transaction object (must be in
 * progress)
 * @returns {Promise} - Resolves to the updated editor model
 */
export function incrementEditorEditCountById(
	orm: Object,
	id: string,
	transacting: Object
): Promise<Object> {
	const {Editor} = orm;
	return new Editor({id})
		.fetch({require: true, transacting})
		.then((editor) => {
			editor.incrementEditCount();
			return editor.save(null, {transacting});
		})
		.catch(Editor.NotFoundError, err => Promise.reject(err));
}

/**
 * Removes all rows from a selection of database tables
 *
 * @param {object} Bookshelf - Bookshelf instance connected to database
 * @param {string[]} tables - List of tables to truncate
 * @returns {Promise} a promise which will be fulfilled when the operation to
 *                    truncate tables completes
 */
export function truncateTables(Bookshelf: Object, tables: Array<string>) {
	return Promise.each(
		tables, (table) => Bookshelf.knex.raw(`TRUNCATE ${table} CASCADE`)
	);
}

/**
 * Return additional relations to withRelated array according to modelType
 *
 * @param {string} modelType - type of the model or entity
 * @returns {array} array of additional relations
 */
export function getAdditionalRelations(modelType) {
	if (modelType === 'Work') {
		return ['disambiguation', 'workType'];
	}
	else if (modelType === 'Edition') {
		return ['disambiguation', 'releaseEventSet.releaseEvents', 'identifierSet.identifiers.type', 'editionFormat'];
	}
	return [];
}
