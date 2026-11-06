import { databaseUrl } from '../config.js';
import { createDatabase } from './client.js';
import { rebuildProjections } from '../issues/rebuild.js';

const database = createDatabase(databaseUrl());

try {
  const result = await rebuildProjections(database.db);
  console.log(
    `Rebuilt ${result.issues} issue projection row(s) from ${result.events} event(s).`,
  );
} catch (error) {
  console.error('Failed to rebuild projections:', error);
  process.exitCode = 1;
} finally {
  await database.close();
}
