import { registerPlugin } from '@/lib/plugin-registry';
import { todayBriefPlugin } from './TodayBriefStub';
import { approvalQueuePlugin } from './ApprovalQueueStub';
import { agentStatusPlugin } from './AgentStatusStub';

registerPlugin(todayBriefPlugin);
registerPlugin(approvalQueuePlugin);
registerPlugin(agentStatusPlugin);

export { todayBriefPlugin, approvalQueuePlugin, agentStatusPlugin };
