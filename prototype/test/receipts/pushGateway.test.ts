import { InMemoryPushGateway } from '../../src/receipts/PushGateway.js';
import { describePushGatewayContract } from './pushGateway.contract.js';

describePushGatewayContract('InMemoryPushGateway', () => new InMemoryPushGateway());
