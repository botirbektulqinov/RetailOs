/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  // Unit specs live beside the code they test; e2e specs live in test/ and run
  // under their own config so they are never mixed into the fast suite.
  testRegex: 'src/.*\.spec\.ts$',
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coveragePathIgnorePatterns: ['\.module\.ts$', 'main\.ts$', '\.dto\.ts$'],
  coverageThreshold: {
    // The money primitives are the one place a rounding bug costs real money,
    // so they carry a hard floor rather than a project-wide average.
    './src/common/money/': { statements: 95, branches: 90, functions: 100, lines: 95 },
  },
};
