// Tests for the cloud / IaC filter family (Batch G): TerraformFilter, AwsFilter, AwsCliFilter, GcloudFilter, AzureCliFilter, AnsibleFilter, PulumiFilter, CdkFilter, VaultFilter, PackerFilter, NixFilter, WranglerFilter, HardhatFilter, ServerlessFilter, FlyFilter, ForgeFilter.
//
// Golden tests ported from the Python TestTerraformFilter, TestAwsFilter, and TestAnsibleFilter / TestAnsibleLintModernFormat classes, plus coverage for the remaining 13 filters and dispatch ordering smoke tests.

import { describe, expect, it } from 'vitest'
import {
  TerraformFilter,
  AwsFilter,
  AwsCliFilter,
  GcloudFilter,
  AzureCliFilter,
  AnsibleFilter,
  PulumiFilter,
  CdkFilter,
  VaultFilter,
  PackerFilter,
  NixFilter,
  WranglerFilter,
  HardhatFilter,
  ServerlessFilter,
  FlyFilter,
  ForgeFilter,
  CLOUD_FILTERS,
} from '../src/tool_filters/cloud.js'
import { selectFilter } from '../src/tool_filters/dispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(
  filter: { apply: (...args: unknown[]) => { text: string; compressedBytes: number } },
  stdout: string,
  stderr: string,
  exitCode: number,
  argv: string[],
): { text: string; compressedBytes: number } {
  return filter.apply(stdout, stderr, exitCode, argv) as { text: string; compressedBytes: number }
}

// ---------------------------------------------------------------------------
// CLOUD_FILTERS dispatch ordering
// ---------------------------------------------------------------------------

describe('CLOUD_FILTERS dispatch ordering', () => {
  it('AwsCliFilter wins for aws cloudformation describe-stack-events', () => {
    const f = selectFilter(['aws', 'cloudformation', 'describe-stack-events'])
    expect(f?.name).toBe('aws-cli')
  })

  it('AwsCliFilter wins for aws s3 sync', () => {
    const f = selectFilter(['aws', 's3', 'sync'])
    expect(f?.name).toBe('aws-cli')
  })

  it('AwsCliFilter wins for aws ec2 describe-instances (json fallback path)', () => {
    // aws-cli is also registered for aws; it handles all aws commands, so it wins over aws because it appears first in CLOUD_FILTERS.
    const f = selectFilter(['aws', 'ec2', 'describe-instances'])
    expect(f?.name).toBe('aws-cli')
  })

  it('TerraformFilter wins for terraform plan', () => {
    const f = selectFilter(['terraform', 'plan'])
    expect(f?.name).toBe('terraform')
  })

  it('TerraformFilter wins for tofu apply', () => {
    const f = selectFilter(['tofu', 'apply'])
    expect(f?.name).toBe('terraform')
  })

  it('AnsibleFilter wins for ansible-playbook', () => {
    const f = selectFilter(['ansible-playbook', 'site.yml'])
    expect(f?.name).toBe('ansible')
  })

  it('AnsibleFilter wins for ansible-lint', () => {
    const f = selectFilter(['ansible-lint', 'playbooks/'])
    expect(f?.name).toBe('ansible')
  })

  it('CLOUD_FILTERS has aws-cli before aws', () => {
    const names = CLOUD_FILTERS.map((f) => f.name)
    expect(names.indexOf('aws-cli')).toBeLessThan(names.indexOf('aws'))
  })

  it('CLOUD_FILTERS contains all 16 expected filters', () => {
    const names = CLOUD_FILTERS.map((f) => f.name)
    for (const expected of [
      'terraform', 'aws-cli', 'aws', 'gcloud', 'azure-cli', 'ansible',
      'pulumi', 'cdk', 'vault', 'packer', 'nix', 'wrangler',
      'hardhat', 'serverless', 'fly', 'forge',
    ]) {
      expect(names).toContain(expected)
    }
    expect(names).toHaveLength(16)
  })
})

// ---------------------------------------------------------------------------
// TerraformFilter — ported from Python TestTerraformFilter
// ---------------------------------------------------------------------------

describe('TerraformFilter', () => {
  const f = new TerraformFilter()

  it('matches terraform', () => expect(f.matches(['terraform', 'plan'])).toBe(true))
  it('matches tofu', () => expect(f.matches(['tofu', 'apply'])).toBe(true))
  it('matches terragrunt', () => expect(f.matches(['terragrunt', 'run-all', 'plan'])).toBe(true))
  it('does not match ansible', () => expect(f.matches(['ansible', 'playbook.yml'])).toBe(false))

  it('drops refresh lines but keeps Plan: summary', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `aws_instance.web[${i}]: Refreshing state... [id=i-abc${i}]`)
    lines.push('Plan: 1 to add, 2 to change, 0 to destroy.')
    const { text } = apply(f, lines.join('\n'), '', 0, ['terraform', 'plan'])
    expect(text).not.toContain('Refreshing state')
    expect(text).toContain('Plan: 1 to add')
  })

  it('compresses plan and reduces size vs raw input', () => {
    const stdout = [
      'aws_instance.example: Refreshing state… [id=i-1234]',
      'aws_instance.other: Refreshing state… [id=i-5678]',
      'Plan: 2 to add, 1 to change, 0 to destroy.',
      '# aws_instance.new will be created',
      '  + resource {',
      '      + id = (known after apply)',
      '    }',
    ].join('\n')
    const result = apply(f, stdout, '', 0, ['terraform', 'plan'])
    expect(result.text).toContain('Plan: 2 to add, 1 to change, 0 to destroy')
    expect(result.text).not.toContain('Refreshing state')
    expect(result.compressedBytes).toBeLessThan(stdout.length)
  })

  it('terraform plan keeps summary + tail of diff for large input', () => {
    const lines = [
      'aws_instance.ex: Refreshing state… [id=i-1]',
      'Plan: 1 to add, 0 to change, 0 to destroy.',
      '# aws_instance.new will be created',
    ]
    for (let i = 0; i < 50; i++) lines.push(`  line_${String(i).padStart(3, '0')} = ${i}`)
    const stdout = lines.join('\n')
    const result = apply(f, stdout, '', 0, ['terraform', 'plan'])
    expect(result.text).toContain('Plan: 1 to add')
    expect(result.compressedBytes).toBeLessThan(stdout.length)
  })

  it('terraform apply keeps Apply complete! line', () => {
    const stdout = [
      'aws_instance.example: Refreshing state… [id=i-1234]',
      'aws_instance.new: Creating…',
      'aws_instance.new: Creation complete after 5s',
      'Apply complete! Resources: 1 added, 0 changed, 0 destroyed.',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['terraform', 'apply'])
    expect(text).toContain('Apply complete! Resources:')
    expect(text).not.toContain('Refreshing state')
  })

  it('terraform apply preserves stderr on error', () => {
    const stdout = 'aws_instance.example: Refreshing state…\n'
    const stderr = 'Error: Resource creation failed\nDetails: Invalid configuration\n'
    const { text } = apply(f, stdout, stderr, 1, ['terraform', 'apply'])
    expect(text).toContain('Error: Resource creation failed')
    expect(text).toContain('Invalid configuration')
  })

  it('terraform init head/tail compression', () => {
    const lines = ['Initializing…']
    for (let i = 0; i < 20; i++) lines.push(`Installing plugin ${i}`)
    lines.push('Init complete!')
    const { text } = apply(f, lines.join('\n'), '', 0, ['terraform', 'init'])
    // Should compress to fewer than all 22 lines
    const nonBlank = text.split('\n').filter((l) => l.trim())
    expect(nonBlank.length).toBeLessThanOrEqual(14)
    // Must include some init info
    expect(text).toMatch(/Initializing|Installing|complete/i)
  })

  it('terraform init wraps the provider-collapse note in the standard [token-goat: ...] marker even when head/tail compression also fires', () => {
    const lines = ['Initializing the backend...']
    for (let i = 0; i < 15; i++) lines.push(`- Finding hashicorp/aws versions matching "~> ${i}.0"...`)
    for (let i = 0; i < 15; i++) lines.push(`Terraform notice line ${i}`)
    lines.push('Terraform has been successfully initialized!')
    const { text } = apply(f, lines.join('\n'), '', 0, ['terraform', 'init'])
    // Every other filter in this codebase emits collapse notes wrapped as `[token-goat: ...]`
    // (see ToolFilter.emitNotes). The provider-collapse note here must follow the same
    // convention instead of appearing as an unwrapped raw line.
    expect(text).toContain('[token-goat: collapsed 15 provider install/find lines]')
    expect(text).not.toMatch(/^collapsed 15 provider install\/find lines$/m)
  })

  it('terraform validate passes through short output', () => {
    const stdout = 'Valid!\nNo issues found.\n'
    const { text } = apply(f, stdout, '', 0, ['terraform', 'validate'])
    expect(text).toContain('Valid!')
    expect(text).toContain('No issues found')
  })

  it('terraform show head/tail for large state output', () => {
    const lines = ['# Resource state']
    for (let i = 0; i < 100; i++) lines.push(`resource.line_${i}`)
    lines.push('# End of state')
    const { text } = apply(f, lines.join('\n'), '', 0, ['terraform', 'show'])
    const nonBlank = text.split('\n').filter((l) => l.trim())
    expect(nonBlank.length).toBeLessThanOrEqual(38)
    expect(text).toMatch(/Resource state|resource\.line_/)
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['terraform', 'plan'])
    expect(typeof text).toBe('string')
  })

  it('select_filter returns TerraformFilter', () => {
    expect(selectFilter(['terraform', 'plan'])?.name).toBe('terraform')
  })
})

// ---------------------------------------------------------------------------
// AwsFilter — ported from Python TestAwsFilter
// ---------------------------------------------------------------------------

describe('AwsFilter', () => {
  const f = new AwsFilter()

  it('matches aws', () => expect(f.matches(['aws', 'ec2', 'describe-instances'])).toBe(true))
  it('matches aws2', () => expect(f.matches(['aws2', 's3', 'ls'])).toBe(true))
  it('does not match gcloud', () => expect(f.matches(['gcloud', 'compute', 'instances', 'list'])).toBe(false))

  it('compresses long JSON array and shows elided marker', () => {
    const data = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `resource-${i}` }))
    const text = JSON.stringify(data)
    const result = apply(f, text, '', 0, ['aws', 'ec2', 'describe-instances'])
    expect(result.text).toContain('items (showing first')
  })

  it('passes short JSON through unchanged', () => {
    const text = '{"foo": "bar"}'
    const result = apply(f, text, '', 0, ['aws', 's3', 'ls'])
    expect(result.text).toContain('foo')
    expect(result.text).not.toContain('elided')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['aws', 's3', 'ls'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// AwsCliFilter — enhanced handler with CFN/S3 routing
// ---------------------------------------------------------------------------

describe('AwsCliFilter', () => {
  const f = new AwsCliFilter()

  it('matches aws', () => expect(f.matches(['aws', 's3', 'sync'])).toBe(true))
  it('matches aws2', () => expect(f.matches(['aws2', 'cloudformation', 'describe-stack-events'])).toBe(true))

  it('collapses S3 upload lines into a count note', () => {
    const lines = ['Starting upload...']
    for (let i = 0; i < 20; i++) lines.push(`upload: ./file-${i}.js to s3://my-bucket/file-${i}.js`)
    lines.push('Completed.')
    const { text } = apply(f, lines.join('\n'), '', 0, ['aws', 's3', 'sync'])
    expect(text).toContain('uploaded 20')
    expect(text).not.toContain('upload: ./file-1.js')
  })

  it('collapses CFN IN_PROGRESS repeated events', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      LogicalResourceId: 'MyBucket',
      ResourceStatus: 'CREATE_IN_PROGRESS',
      EventId: `event-${i}`,
    }))
    events.push({
      LogicalResourceId: 'MyBucket',
      ResourceStatus: 'CREATE_COMPLETE',
      EventId: 'event-final',
    })
    const payload = JSON.stringify({ StackEvents: events }, null, 2)
    const { text } = apply(
      f,
      payload,
      '',
      0,
      ['aws', 'cloudformation', 'describe-stack-events'],
    )
    // Should collapse repeated IN_PROGRESS events
    expect(text).toContain('collapsed')
    expect(text).toContain('MyBucket')
  })

  it('compresses large generic JSON array', () => {
    const arr = Array.from({ length: 20 }, (_, i) => ({ id: i }))
    const payload = JSON.stringify(arr)
    const { text } = apply(f, payload, '', 0, ['aws', 'ec2', 'describe-snapshots'])
    expect(text).toContain('items (showing first')
  })

  it('select_filter dispatches aws to aws-cli (not aws)', () => {
    const result = selectFilter(['aws', 's3', 'sync'])
    expect(result?.name).toBe('aws-cli')
  })

  it('truncates a real --output table result (regression: AwsFilter table fallback was unreachable behind AwsCliFilter dispatch win)', () => {
    // Shape captured from real `aws s3api list-objects-v2 --no-sign-request --output table` output.
    const header = [
      '-----------------------------------------------------------------------------',
      '|                               ListObjectsV2                               |',
      '+---------------------------------------------------------------------------+',
    ]
    const rows = Array.from(
      { length: 40 },
      (_, i) => `|  "etag-${i}"  |  key/path-${i}.dat  |  2024-01-01T00:00:00+00:00  |  ${i}  |  STANDARD  |`,
    )
    const text = [...header, ...rows].join('\n')
    const { text: result } = apply(f, text, '', 0, [
      'aws', 'ec2', 'describe-instances', '--output', 'table',
    ])
    expect(result).toContain('more rows')
    expect(result).not.toContain('key/path-39.dat')
    // Regression: this hint used to be copy-pasted verbatim from the kubectl table
    // truncation helper ("use --selector or -l to narrow"), telling AWS CLI users to pass
    // kubectl-only flags that don't exist on `aws`. It must name real AWS CLI narrowing
    // mechanisms instead.
    expect(result).toContain('use --query or --max-items to narrow')
    expect(result).not.toContain('--selector')
  })
})

// ---------------------------------------------------------------------------
// GcloudFilter
// ---------------------------------------------------------------------------

describe('GcloudFilter', () => {
  const f = new GcloudFilter()

  it('matches gcloud', () => expect(f.matches(['gcloud', 'compute', 'instances', 'list'])).toBe(true))
  it('does not match az', () => expect(f.matches(['az', 'vm', 'list'])).toBe(false))

  it('drops spinner lines', () => {
    const stdout = [
      '⠏ Uploading...',
      '⠋ Uploading...',
      'Updated [https://compute.googleapis.com/compute/v1/projects/my-project/regions/us-central1/routers/my-router].',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['gcloud', 'compute', 'routers', 'update'])
    expect(text).not.toMatch(/^[⠏⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /m)
    expect(text).toContain('Updated [https://')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['gcloud', 'compute', 'instances', 'list'])
    expect(typeof text).toBe('string')
  })

  // Regression: _maybeCollapseStructured used to fire on ANY output over 20
  // non-blank lines where >=70% of lines contained {}/[]/:/- -- which is
  // ordinary YAML key-value/list syntax, so it fired on nearly every real
  // `describe` output and replaced it with a single placeholder line,
  // destroying the actual answer (status/IPs/config) the command was run to
  // retrieve. It must now require 2+ `---` document separators (gcloud's own
  // marker for repeated resource blocks from `list --format=yaml`) before
  // collapsing anything.
  it('does NOT collapse a single `describe` YAML document (the actual answer)', () => {
    const stdout = [
      'name: my-instance',
      'zone: us-central1-a',
      'machineType: n1-standard-2',
      'status: RUNNING',
      'statusMessage: Instance is running',
      "creationTimestamp: '2026-01-15T08:23:11.123-08:00'",
      "id: '1234567890123456789'",
      'selfLink: https://compute.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/instances/my-instance',
      'networkInterfaces:',
      '- name: nic0',
      '  network: https://www.googleapis.com/compute/v1/projects/my-project/global/networks/default',
      '  networkIP: 10.128.0.5',
      '  subnetwork: https://www.googleapis.com/compute/v1/projects/my-project/regions/us-central1/subnetworks/default',
      '  accessConfigs:',
      '  - name: External NAT',
      '    natIP: 34.121.45.67',
      '    type: ONE_TO_ONE_NAT',
      'disks:',
      '- boot: true',
      '  autoDelete: true',
      '  deviceName: persistent-disk-0',
      '  mode: READ_WRITE',
      '  source: https://www.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/disks/my-instance',
      'labels:',
      '  env: production',
      '  team: platform',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['gcloud', 'compute', 'instances', 'describe', 'my-instance', '--format=yaml'])
    expect(text).not.toMatch(/\[Resource description:/)
    expect(text).toContain('status: RUNNING')
    expect(text).toContain('networkIP: 10.128.0.5')
    expect(text).toContain('natIP: 34.121.45.67')
    expect(text).toContain('deviceName: persistent-disk-0')
  })

  it('DOES collapse a genuinely repeated multi-resource `list --format=yaml` dump', () => {
    const oneInstance = (n: number, ip: string) => [
      '---',
      `name: instance-${n}`,
      'zone: us-central1-a',
      'machineType: n1-standard-2',
      'status: RUNNING',
      'networkInterfaces:',
      '- name: nic0',
      `  networkIP: 10.128.0.${n}`,
      '  accessConfigs:',
      `  - natIP: ${ip}`,
      'disks:',
      '- boot: true',
      '  deviceName: persistent-disk-0',
      'labels:',
      '  env: production',
    ]
    const stdout = [
      ...oneInstance(1, '34.121.45.10'),
      ...oneInstance(2, '34.121.45.11'),
      ...oneInstance(3, '34.121.45.12'),
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['gcloud', 'compute', 'instances', 'list', '--format=yaml'])
    expect(text).toMatch(/\[Resource description:/)
    expect(text).not.toContain('instance-1')
    expect(text).not.toContain('instance-2')
    expect(text).not.toContain('instance-3')
  })

  it('does not collapse a single `list --format=yaml` result (only 1 separator, above the 20-line gate)', () => {
    const stdout = [
      '---',
      'name: only-instance',
      'zone: us-central1-a',
      'machineType: n1-standard-2',
      'status: RUNNING',
      "creationTimestamp: '2026-01-15T08:23:11.123-08:00'",
      "id: '9876543210987654321'",
      'networkInterfaces:',
      '- name: nic0',
      '  networkIP: 10.128.0.9',
      '  accessConfigs:',
      '  - natIP: 34.121.45.99',
      '    type: ONE_TO_ONE_NAT',
      'disks:',
      '- boot: true',
      '  deviceName: persistent-disk-0',
      '  mode: READ_WRITE',
      '  source: https://www.googleapis.com/compute/v1/projects/my-project/zones/us-central1-a/disks/only-instance',
      'labels:',
      '  env: production',
      '  team: platform',
      'tags:',
      '  items:',
      '  - http-server',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['gcloud', 'compute', 'instances', 'list', '--format=yaml'])
    expect(text).not.toMatch(/\[Resource description:/)
    expect(text).toContain('name: only-instance')
  })
})

// ---------------------------------------------------------------------------
// AzureCliFilter
// ---------------------------------------------------------------------------

describe('AzureCliFilter', () => {
  const f = new AzureCliFilter()

  it('matches az', () => expect(f.matches(['az', 'vm', 'list'])).toBe(true))
  it('does not match gcloud', () => expect(f.matches(['gcloud', 'projects', 'list'])).toBe(false))

  it('compresses large JSON array', () => {
    const arr = Array.from({ length: 15 }, (_, i) => ({ id: `vm-${i}`, name: `vm-${i}` }))
    const { text } = apply(f, JSON.stringify(arr), '', 0, ['az', 'vm', 'list'])
    expect(text).toContain('items (showing first')
  })

  it('collapses preview warnings', () => {
    const stdout = [
      'Command group \'vm\' is in preview and under development.',
      'This command is in preview and under development.',
      '{"id": "vm-1"}',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['az', 'vm', 'create'])
    expect(text).not.toContain('is in preview and under development')
    expect(text).toContain('preview warning')
  })

  it('collapses repeated provisioning progress JSON lines', () => {
    const lines: string[] = []
    for (let i = 0; i < 8; i++) {
      lines.push(`  {"status": "Running", "percentComplete": ${i * 10}}`)
    }
    lines.push('  {"status": "Succeeded", "percentComplete": 100}')
    const { text } = apply(f, lines.join('\n'), '', 0, ['az', 'deployment', 'create'])
    // Only last status should remain (or collapsed)
    const progressLines = text.split('\n').filter((l) => l.includes('"Running"'))
    expect(progressLines.length).toBeLessThan(5)
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['az', 'vm', 'list'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// AnsibleFilter — ported from Python TestAnsibleFilter + TestAnsibleLintModernFormat
// ---------------------------------------------------------------------------

describe('AnsibleFilter', () => {
  const f = new AnsibleFilter()

  it('matches ansible-playbook', () => expect(f.matches(['ansible-playbook', 'site.yml'])).toBe(true))
  it('matches ansible', () => expect(f.matches(['ansible', 'all', '-m', 'ping'])).toBe(true))
  it('matches ansible-galaxy', () => expect(f.matches(['ansible-galaxy', 'install', '-r', 'req.yml'])).toBe(true))
  it('matches ansible-lint', () => expect(f.matches(['ansible-lint', 'playbooks/'])).toBe(true))
  it('does not match terraform', () => expect(f.matches(['terraform', 'plan'])).toBe(false))

  it('collapses ok/changed/skipping status lines per task', () => {
    const stdout = [
      'PLAY [Install packages]',
      'TASK [apt-get update]',
      'ok: [host1]',
      'ok: [host2]',
      'ok: [host3]',
      'changed: [host4]',
      'changed: [host5]',
      'TASK [Install nginx]',
      'ok: [host1]',
      'ok: [host2]',
      'skipped: [host3]',
      'PLAY RECAP',
      'host1: ok=2, changed=0, unreachable=0, failed=0',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['ansible-playbook', 'site.yml'])
    expect(text).toContain('PLAY [Install packages]')
    expect(text).toContain('TASK [apt-get update]')
    expect(text).toContain('PLAY RECAP')
    // Raw "ok:" lines should be gone — collapsed into token-goat note
    const rawOkLines = text.split('\n').filter((l) => /^ok:\s*\[/.test(l))
    expect(rawOkLines).toHaveLength(0)
    expect(text).toContain('token-goat:')
  })

  it('preserves fatal/failed lines and their JSON payload', () => {
    const stdout = [
      'TASK [Might fail]',
      'ok: [host1]',
      'fatal: [host2]: FAILED! => {',
      '    "msg": "Something went wrong",',
      '    "error": "Connection refused"',
      '}',
      'PLAY RECAP',
      'host1: ok=1, changed=0, failed=1',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['ansible-playbook', 'site.yml'])
    expect(text).toContain('fatal: [host2]')
    expect(text).toMatch(/Something went wrong|Connection refused/)
    expect(text).toContain('PLAY RECAP')
  })

  it('always preserves the PLAY RECAP section', () => {
    const stdout = [
      'PLAY [test]',
      'TASK [task1]',
      'ok: [host1]',
      'PLAY RECAP',
      'host1: ok=1, changed=0, unreachable=0, failed=0',
      'host2: ok=0, changed=0, unreachable=1, failed=0',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['ansible-playbook', 'site.yml'])
    expect(text).toContain('PLAY RECAP')
    expect(text).toContain('host1: ok=1')
    expect(text).toContain('host2: ok=0, changed=0, unreachable=1')
  })

  it('ansible-galaxy uses head/tail compression', () => {
    const lines = ['Starting galaxy install']
    for (let i = 0; i < 30; i++) lines.push(`Installing package_${i}`)
    lines.push('Galaxy install complete')
    const { text } = apply(f, lines.join('\n'), '', 0, ['ansible-galaxy', 'install', '-r', 'requirements.yml'])
    const nonBlank = text.split('\n').filter((l) => l.trim())
    expect(nonBlank.length).toBeLessThanOrEqual(13)
    expect(text).toMatch(/Installing|complete/)
  })

  it('ansible-lint groups violations by rule and keeps first 3', () => {
    const lines = [
      'playbooks/site.yml:10:1: yaml-indent: too many spaces before block scalar (yaml-indent)',
      'playbooks/site.yml:20:1: yaml-indent: too many spaces before block scalar (yaml-indent)',
      'playbooks/site.yml:30:1: yaml-indent: too many spaces before block scalar (yaml-indent)',
      'playbooks/site.yml:40:1: yaml-indent: too many spaces before block scalar (yaml-indent)',
      'playbooks/site.yml:50:1: line-too-long: line too long (line-too-long)',
      'playbooks/site.yml:60:1: line-too-long: line too long (line-too-long)',
      'Linting failed.',
    ]
    const { text } = apply(f, lines.join('\n'), '', 1, ['ansible-lint', 'playbooks/'])
    const yamlViolLines = text
      .split('\n')
      .filter((ln) => ln.includes('yaml-indent') && !ln.includes('elided') && !ln.includes('token-goat'))
    // 4 yaml-indent violations, capped to the first 3.
    expect(yamlViolLines.length).toBe(3)
    expect(text).toContain('elided')
    expect(text).toContain('more occurrence')
  })

  it('ansible-lint modern yaml[tag] rule codes are grouped', () => {
    const lines = Array.from(
      { length: 6 },
      (_, i) => `yaml[line-length]: ./playbooks/site.yml:${10 + i}:80: Line too long (120 > 80 chars)`,
    )
    lines.push('Linting completed.')
    const { text } = apply(f, lines.join('\n'), '', 1, ['ansible-lint', 'playbooks/'])
    expect(text).toContain('yaml[line-length]')
    const violLines = text
      .split('\n')
      .filter((ln) => ln.includes('yaml[line-length]') && !ln.includes('elided') && !ln.includes('token-goat'))
    // 6 violations for one rule, capped to the first 3.
    expect(violLines.length).toBe(3)
    expect(text).toMatch(/elided|more occurrence/)
  })

  it('ansible-lint multiple rules each get up to 3 examples', () => {
    const yamlLines = Array.from({ length: 4 }, (_, i) => `yaml[line-length]: ./file.yml:${i}:80: Too long`)
    const truthyLines = Array.from({ length: 4 }, (_, i) => `yaml[truthy]: ./vars.yml:${i}:1: Use true/false`)
    const { text } = apply(f, [...yamlLines, ...truthyLines, 'Done.'].join('\n'), '', 1, ['ansible-lint', 'playbooks/'])
    expect(text).toContain('yaml[line-length]')
    expect(text).toContain('yaml[truthy]')
    const llViol = text.split('\n').filter((ln) => ln.includes('yaml[line-length]') && !ln.includes('elided') && !ln.includes('token-goat'))
    const truthyViol = text.split('\n').filter((ln) => ln.includes('yaml[truthy]') && !ln.includes('elided') && !ln.includes('token-goat'))
    expect(llViol.length).toBeLessThanOrEqual(3)
    expect(truthyViol.length).toBeLessThanOrEqual(3)
  })

  it('ansible-lint first violation is always included', () => {
    const stdout = 'yaml[line-length]: ./file.yml:10:80: Line too long\nLinting failed.\n'
    const { text } = apply(f, stdout, '', 1, ['ansible-lint', 'file.yml'])
    expect(text).toContain('yaml[line-length]')
    expect(text).toContain('./file.yml:10:80')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['ansible-playbook', 'site.yml'])
    expect(typeof text).toBe('string')
  })

  it('reduces size substantially for large playbook output', () => {
    const lines = ['PLAY [test]', 'TASK [loop]']
    for (let i = 0; i < 100; i++) lines.push(`ok: [host-${i % 10}]`)
    lines.push('PLAY RECAP\nhost-0: ok=10')
    const stdout = lines.join('\n')
    const result = apply(f, stdout, '', 0, ['ansible-playbook', 'site.yml'])
    expect(result.compressedBytes).toBeLessThan(stdout.length * 0.7)
  })

  it('select_filter dispatches ansible-playbook to AnsibleFilter', () => {
    expect(selectFilter(['ansible-playbook', 'site.yml'])?.name).toBe('ansible')
  })
})

// ---------------------------------------------------------------------------
// PulumiFilter
// ---------------------------------------------------------------------------

describe('PulumiFilter', () => {
  const f = new PulumiFilter()

  it('matches pulumi', () => expect(f.matches(['pulumi', 'up'])).toBe(true))
  it('does not match cdk', () => expect(f.matches(['cdk', 'deploy'])).toBe(false))

  it('drops resource progress and still lines', () => {
    // Pulumi "still" lines match ^\s+[resource]\s+([^)]+):\s+still\s+ Real Pulumi format: " my-bucket (5s elapsed): still creating"
    const stdout = [
      'Updating (dev):',
      '     my-bucket  (creating)',
      '     my-bucket  (5s elapsed): still creating',
      '     my-bucket  (created)',
      'Resources:',
      '    + 1 created',
      'Duration: 10s',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['pulumi', 'up'])
    expect(text).not.toContain('still creating')
    expect(text).toContain('Resources:')
    expect(text).toContain('Duration: 10s')
    expect(text).toContain('dropped')
  })

  it('keeps error lines', () => {
    const stdout = 'error: update failed: resource group creation failed\n'
    const { text } = apply(f, stdout, '', 1, ['pulumi', 'up'])
    expect(text).toContain('error:')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['pulumi', 'up'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// CdkFilter
// ---------------------------------------------------------------------------

describe('CdkFilter', () => {
  const f = new CdkFilter()

  it('matches cdk', () => expect(f.matches(['cdk', 'deploy'])).toBe(true))
  it('does not match pulumi', () => expect(f.matches(['pulumi', 'up'])).toBe(false))

  it('drops asset progress lines but keeps COMPLETE events', () => {
    // CDK IN_PROGRESS lines match ^\s+\w+_IN_PROGRESS\s+ — the status code must appear right after leading whitespace (CDK's condensed event table).
    const stdout = [
      'MyStack: deploying...',
      '  [100%] asset.12345 uploaded',
      '  CREATE_COMPLETE                AWS::S3::Bucket',
      '  CREATE_IN_PROGRESS             AWS::S3::Bucket',
      '✅  MyStack',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['cdk', 'deploy'])
    expect(text).not.toContain('[100%] asset')
    expect(text).not.toContain('CREATE_IN_PROGRESS')
    expect(text).toContain('CREATE_COMPLETE')
    expect(text).toContain('✅')
  })

  it('keeps error lines', () => {
    const stdout = '❌  MyStack failed: Error: MyBucket/Resource failed to create\n'
    const { text } = apply(f, stdout, '', 1, ['cdk', 'deploy'])
    expect(text).toContain('failed')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['cdk', 'deploy'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// VaultFilter
// ---------------------------------------------------------------------------

describe('VaultFilter', () => {
  const f = new VaultFilter()

  it('matches vault', () => expect(f.matches(['vault', 'kv', 'get', 'secret/my-app'])).toBe(true))
  it('does not match packer', () => expect(f.matches(['packer', 'build'])).toBe(false))

  it('collapses lease/token metadata lines', () => {
    const stdout = [
      'Key                 Value',
      'lease_id            hvs.abc123',
      'lease_duration      768h',
      'lease_renewable     true',
      'token_policies      default',
      'renewable           true',
      'mykey               myvalue',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['vault', 'read', 'secret/data/myapp'])
    expect(text).not.toContain('lease_id')
    expect(text).not.toContain('token_policies')
    expect(text).toContain('mykey')
    expect(text).toContain('collapsed')
  })

  it('shows first 5 list items then elides rest for long lists', () => {
    // Realistic `vault kv list` output: flush-left keys, single-dash divider.
    const items = Array.from({ length: 15 }, (_, i) => `secret-${i}`)
    const stdout = ['Keys', '----', ...items].join('\n')
    const { text } = apply(f, stdout, '', 0, ['vault', 'kv', 'list', 'secret/'])
    const secretLines = text.split('\n').filter((l) => /secret-\d+/.test(l))
    expect(secretLines.length).toBeLessThanOrEqual(5)
    expect(text).toContain('more secret path')
  })

  it('recognizes the real single-dash divider and keeps collecting keys through it', () => {
    const stdout = ['Keys', '----', 'alpha', 'beta', 'gamma/'].join('\n')
    const { text } = apply(f, stdout, '', 0, ['vault', 'list', 'secret/'])
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).toContain('gamma/')
    expect(text).not.toContain('----')
  })

  it('collapses a realistic full vault kv list transcript with real key names', () => {
    const keys = [
      'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
      'hotel', 'india', 'juliet', 'kilo', 'lima',
    ]
    const stdout = ['Keys', '----', ...keys].join('\n')
    const { text } = apply(f, stdout, '', 0, ['vault', 'kv', 'list', 'secret/'])
    const keyLines = text.split('\n').filter((l) => keys.includes(l.trim()))
    expect(keyLines.length).toBeLessThanOrEqual(5)
    expect(text).toContain('more secret path')
  })

  it('matches a full-path vault invocation for list collapsing', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `secret-${i}`)
    const stdout = ['Keys', '----', ...keys].join('\n')
    const { text } = apply(f, stdout, '', 0, ['/usr/local/bin/vault', 'list', 'secret/'])
    expect(text).toContain('more secret path')
  })

  it('matches a vault.exe invocation for list collapsing', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `secret-${i}`)
    const stdout = ['Keys', '----', ...keys].join('\n')
    const { text } = apply(f, stdout, '', 0, ['vault.exe', 'kv', 'list', 'secret/'])
    expect(text).toContain('more secret path')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['vault', 'kv', 'get', 'secret/myapp'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// PackerFilter
// ---------------------------------------------------------------------------

describe('PackerFilter', () => {
  const f = new PackerFilter()

  it('matches packer', () => expect(f.matches(['packer', 'build', '.'])).toBe(true))
  it('does not match vault', () => expect(f.matches(['vault', 'kv', 'get'])).toBe(false))

  it('collapses SSH wait lines and notes the count', () => {
    const lines = ['==> amazon-ebs: Running...']
    for (let i = 0; i < 10; i++) lines.push(`==> amazon-ebs: Waiting for SSH (attempt ${i})`)
    lines.push('==> amazon-ebs: Connected to SSH')
    lines.push('==> Builds finished. The artifacts of successful builds are:')
    const { text } = apply(f, lines.join('\n'), '', 0, ['packer', 'build', '.'])
    expect(text).toContain('SSH')
    expect(text).toContain('collapsed')
    // Wait lines should not appear verbatim
    const waitLines = text.split('\n').filter((l) => /Waiting for SSH \(attempt/.test(l))
    expect(waitLines.length).toBe(0)
  })

  it('keeps build artifacts line', () => {
    const stdout = '==> Builds finished. The artifacts of successful builds are:\n--> amazon-ebs: AMI: ami-12345\n'
    const { text } = apply(f, stdout, '', 0, ['packer', 'build'])
    expect(text).toContain('Builds finished')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['packer', 'build'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// NixFilter
// ---------------------------------------------------------------------------

describe('NixFilter', () => {
  const f = new NixFilter()

  it('matches nix', () => expect(f.matches(['nix', 'build'])).toBe(true))
  it('matches nix-build', () => expect(f.matches(['nix-build', '.'])).toBe(true))
  it('matches nixos-rebuild', () => expect(f.matches(['nixos-rebuild', 'switch'])).toBe(true))
  it('does not match packer', () => expect(f.matches(['packer', 'build'])).toBe(false))

  it('collapses fetch and build lines into notes', () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i++) lines.push(`copying path '/nix/store/hash${i}-pkg-${i}' from 'https://cache.nixos.org'`)
    for (let i = 0; i < 5; i++) lines.push(`building '/nix/store/hash${i}-drv-${i}.drv'`)
    lines.push('Result: /nix/store/output-hash')
    const { text } = apply(f, lines.join('\n'), '', 0, ['nix', 'build'])
    expect(text).toContain('fetched/substituted 10')
    expect(text).toContain('built 5')
    expect(text).not.toContain("copying path '/nix")
    expect(text).not.toContain("building '/nix")
  })

  it('keeps error lines', () => {
    const stdout = 'error: build of \'/nix/store/foo.drv\' failed\n'
    const { text } = apply(f, stdout, '', 1, ['nix', 'build'])
    expect(text).toContain('error:')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['nix', 'build'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// WranglerFilter
// ---------------------------------------------------------------------------

describe('WranglerFilter', () => {
  const f = new WranglerFilter()

  it('matches wrangler', () => expect(f.matches(['wrangler', 'deploy'])).toBe(true))
  it('matches wrangler2', () => expect(f.matches(['wrangler2', 'publish'])).toBe(true))
  it('does not match sls', () => expect(f.matches(['sls', 'deploy'])).toBe(false))

  it('collapses asset upload lines into a count note', () => {
    const lines = ['Building...']
    for (let i = 0; i < 25; i++) lines.push(`+ /file-${i}.js (1234 bytes)`)
    lines.push('Deployed my-worker (https://my-worker.example.workers.dev)')
    const { text } = apply(f, lines.join('\n'), '', 0, ['wrangler', 'deploy'])
    expect(text).toContain('25 asset upload')
    expect(text).not.toContain('/file-1.js')
    expect(text).toContain('Deployed')
  })

  it('keeps error lines', () => {
    const stdout = 'Error: Failed to deploy: unauthorized\n'
    const { text } = apply(f, stdout, '', 1, ['wrangler', 'deploy'])
    expect(text).toContain('Error:')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['wrangler', 'deploy'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// HardhatFilter
// ---------------------------------------------------------------------------

describe('HardhatFilter', () => {
  const f = new HardhatFilter()

  it('matches hardhat', () => expect(f.matches(['hardhat', 'test'])).toBe(true))
  it('does not match forge', () => expect(f.matches(['forge', 'test'])).toBe(false))

  it('collapses Solidity compilation steps and passing tests into notes', () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) lines.push(`Compiling ${i} files with solc 0.8.24`)
    lines.push('Compilation finished successfully')
    for (let i = 0; i < 30; i++) lines.push(`    ✓ test_function_${i}`)
    lines.push('  30 passing (5s)')
    const { text } = apply(f, lines.join('\n'), '', 0, ['hardhat', 'test'])
    expect(text).toContain('collapsed 5')
    expect(text).toContain('30 passing')
    const passingLines = text.split('\n').filter((l) => /✓ test_function_/.test(l))
    expect(passingLines.length).toBe(0)
  })

  it('keeps error/failure lines', () => {
    const stdout = 'AssertionError: expected 1 to equal 2\n  3 failing\n'
    const { text } = apply(f, stdout, '', 1, ['hardhat', 'test'])
    expect(text).toContain('AssertionError')
    expect(text).toContain('3 failing')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['hardhat', 'test'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// ServerlessFilter
// ---------------------------------------------------------------------------

describe('ServerlessFilter', () => {
  const f = new ServerlessFilter()

  it('matches serverless', () => expect(f.matches(['serverless', 'deploy'])).toBe(true))
  it('matches sls', () => expect(f.matches(['sls', 'deploy'])).toBe(true))
  it('does not match wrangler', () => expect(f.matches(['wrangler', 'deploy'])).toBe(false))

  it('collapses deploy step lines into a note', () => {
    const stdout = [
      'Serverless: Packaging service...',
      'Serverless: Excluding development dependencies...',
      'Serverless: Uploading CloudFormation file to S3...',
      'Serverless: Uploading artifacts...',
      'Serverless: Validating template...',
      'Serverless: Updating Stack...',
      'Serverless: Checking Stack update progress...',
      'Serverless: Stack update finished...',
      'Service Information',
      'service: my-service',
      'stage: dev',
      'region: us-east-1',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['sls', 'deploy'])
    expect(text).toContain('collapsed')
    expect(text).not.toContain('Packaging service')
    expect(text).toContain('Service Information')
    expect(text).toContain('my-service')
  })

  it('keeps error lines', () => {
    const stdout = 'Serverless: ERROR: Deployment failed: AccessDenied\n'
    const { text } = apply(f, stdout, '', 1, ['sls', 'deploy'])
    expect(text).toContain('ERROR')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['sls', 'deploy'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// FlyFilter
// ---------------------------------------------------------------------------

describe('FlyFilter', () => {
  const f = new FlyFilter()

  it('matches fly', () => expect(f.matches(['fly', 'deploy'])).toBe(true))
  it('matches flyctl', () => expect(f.matches(['flyctl', 'deploy'])).toBe(true))
  it('does not match serverless', () => expect(f.matches(['serverless', 'deploy'])).toBe(false))

  it('collapses Docker build steps and machine wait lines into notes', () => {
    const lines = ['==> Building image']
    for (let i = 0; i < 10; i++) lines.push(`Step ${i}/20 : RUN npm install`)
    for (let i = 0; i < 5; i++) lines.push(`--> Waiting for machine m1 to reach state ready`)
    lines.push('Deployed my-app v5 successfully')
    const { text } = apply(f, lines.join('\n'), '', 0, ['fly', 'deploy'])
    expect(text).toContain('Docker build step')
    expect(text).toContain('machine wait')
    const dockerLines = text.split('\n').filter((l) => /Step \d+\/20/.test(l))
    expect(dockerLines.length).toBe(0)
  })

  it('keeps error lines', () => {
    const stdout = 'Error: failed to deploy: out of resources\n'
    const { text } = apply(f, stdout, '', 1, ['fly', 'deploy'])
    expect(text).toContain('Error:')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['fly', 'deploy'])
    expect(typeof text).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// ForgeFilter
// ---------------------------------------------------------------------------

describe('ForgeFilter', () => {
  const f = new ForgeFilter()

  it('matches forge', () => expect(f.matches(['forge', 'test'])).toBe(true))
  it('matches forge build', () => expect(f.matches(['forge', 'build'])).toBe(true))
  it('does not match hardhat', () => expect(f.matches(['hardhat', 'test'])).toBe(false))

  it('collapses Solidity compilation steps and passing tests into notes', () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) lines.push(`Compiling ${i} files with solc 0.8.24`)
    lines.push('Compiler run successful!')
    lines.push('Running 10 tests for TestCounter')
    for (let i = 0; i < 10; i++) lines.push(`  [PASS] test_${i}() (gas: 12345)`)
    lines.push('Test result: ok. 10 passed; 0 failed; 0 skipped')
    const { text } = apply(f, lines.join('\n'), '', 0, ['forge', 'test'])
    expect(text).toContain('collapsed')
    expect(text).toContain('passing test')
    const passLines = text.split('\n').filter((l) => /\[PASS\] test_\d/.test(l))
    expect(passLines.length).toBe(0)
    expect(text).toContain('Test result:')
  })

  it('keeps failure lines', () => {
    const stdout = '[FAIL] test_badmath() (gas: 8000)\nTest result: FAILED. 0 passed; 1 failed\n'
    const { text } = apply(f, stdout, '', 1, ['forge', 'test'])
    expect(text).toContain('[FAIL]')
    expect(text).toContain('FAILED')
  })

  it('handles empty input without crashing', () => {
    const { text } = apply(f, '', '', 0, ['forge', 'test'])
    expect(typeof text).toBe('string')
  })
})

// TerraformFilter regex fix for change markers
describe('TerraformFilter change markers in resource blocks', () => {
  const f = new TerraformFilter()

  it('recognizes resource blocks with +/~/- change markers', () => {
    // The regex now allows optional change markers (+/~/-) before "resource"
    const stdout = [
      'Plan: 2 to add, 1 to change, 1 to destroy.',
      '  + resource "aws_instance" "new" {',
      '      + id = (known after apply)',
      '    }',
      '  ~ resource "aws_s3_bucket" "existing" {',
      '      ~ acl = "private" -> "public"',
      '    }',
      '  - resource "aws_lb" "old" {',
      '      - dns_name = (known after apply)',
      '    }',
    ].join('\n')
    const { text } = apply(f, stdout, '', 0, ['terraform', 'plan'])
    // Should keep the plan summary and resource blocks
    expect(text).toContain('Plan: 2 to add, 1 to change, 1 to destroy.')
    expect(text).toContain('aws_instance')
    expect(text).toContain('aws_s3_bucket')
    expect(text).toContain('aws_lb')
  })
})
