import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

describe('extract_entities script', () => {
  const scriptPath = resolve(__dirname, '../scripts/extract_entities.py');

  it('extracts activities from json and text files', () => {
    const tmpJson = resolve(__dirname, '../scripts/.tmp_test_entities.json');
    try {
      const data = [
        { page: 1, text: 'Activity 1: Setup database\nActivity 2: Configure router' },
        { page: 2, text: 'Activity 3: Write tests\nSome random noise' },
      ];
      writeFileSync(tmpJson, JSON.stringify(data), 'utf8');

      const stdout = execFileSync('python', [scriptPath, tmpJson, '--type', 'activities', '--format', 'json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].id).toBe(1);
      expect(parsed[0].content).toContain('Setup database');
      expect(parsed[1].id).toBe(2);
      expect(parsed[2].id).toBe(3);
    } finally {
      if (existsSync(tmpJson)) {
        unlinkSync(tmpJson);
      }
    }
  });

  it('extracts comments and tasks from code and style files', () => {
    const tmpTs = resolve(__dirname, '../scripts/.tmp_test_code.ts');
    try {
      const tsCode = `
// Task 1: Initialize server
const port = 3000;
/* Task 2: Bind listener */
app.listen(port);
`;
      writeFileSync(tmpTs, tsCode, 'utf8');

      const stdout = execFileSync('python', [scriptPath, tmpTs, '--type', 'tasks', '--format', 'json'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe(1);
      expect(parsed[0].content).toContain('Initialize server');
      expect(parsed[1].id).toBe(2);
      expect(parsed[1].content).toContain('Bind listener');
    } finally {
      if (existsSync(tmpTs)) {
        unlinkSync(tmpTs);
      }
    }
  });

  it('runs process_activities backward-compatible wrapper', () => {
    const procScript = resolve(__dirname, '../scripts/process_activities.py');
    const tmpJson = resolve(__dirname, '../scripts/.tmp_test_act.json');
    const tmpOut = resolve(__dirname, '../scripts/.tmp_test_act_out.json');
    try {
      const data = [{ page: 1, text: 'Activity 1: Complete setup\nActivity 2: Run verification' }];
      writeFileSync(tmpJson, JSON.stringify(data), 'utf8');

      const stdout = execFileSync('python', [procScript, tmpJson, tmpOut, '--inspect'], {
        encoding: 'utf8',
      });
      expect(stdout).toContain('Activities detected (1-250): 2');
      expect(stdout).toContain('Complete setup');
    } finally {
      if (existsSync(tmpJson)) unlinkSync(tmpJson);
      if (existsSync(tmpOut)) unlinkSync(tmpOut);
    }
  });
});
