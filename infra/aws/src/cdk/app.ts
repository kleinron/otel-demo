import { App, Tags } from 'aws-cdk-lib';
import { DemoStack } from './demo-stack.js';
import { EXPERIMENT_TAG_KEY, EXPERIMENT_TAG_VALUE } from '../tags.js';

// Environment-agnostic so synth does not need an account. Deploy with --region eu-central-1.
const app = new App();
Tags.of(app).add(EXPERIMENT_TAG_KEY, EXPERIMENT_TAG_VALUE);
new DemoStack(app, 'otel-demo', {
  description:
    'otel-demo experiment. Database backups are off. No NAT gateway. No CloudWatch alarms.',
});
