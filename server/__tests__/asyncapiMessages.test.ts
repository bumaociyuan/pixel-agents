import * as fs from 'node:fs';
import * as path from 'node:path';

import { Parser } from '@asyncapi/parser';
import { describe, expect, it } from 'vitest';

describe('AsyncAPI agent project placement metadata', () => {
  it('allows project placement metadata without making legacy agent payloads invalid', async () => {
    const specPath = path.join(__dirname, '../../core/asyncapi.yaml');
    const { document, diagnostics } = await new Parser().parse(fs.readFileSync(specPath, 'utf8'));
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === 0)).toEqual([]);

    const schemas = (document?.json() as { components: { schemas: Record<string, Schema> } })
      .components.schemas;
    for (const schemaName of ['AgentCreated', 'AgentSeatMeta']) {
      const schema = schemas[schemaName]!;
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required ?? []).not.toEqual(
        expect.arrayContaining(['projectKey', 'projectAreaLabels', 'preferredArea']),
      );
      expect(schema.properties).toMatchObject({
        projectKey: { type: 'string' },
        projectAreaLabels: { type: 'array', items: { type: 'string' } },
        preferredArea: { type: 'string' },
      });
    }
  });
});

interface Schema {
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, unknown>;
}
