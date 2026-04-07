import { registerPlugin } from '@/lib/plugin-registry';
import { todayBriefPlugin } from './TodayBriefStub';
import { approvalQueuePlugin } from './ApprovalQueueStub';
import { agentStatusPlugin } from './AgentStatusStub';
import { projectBuilderPlugin } from '../ProjectBuilder';

registerPlugin(todayBriefPlugin);
registerPlugin(approvalQueuePlugin);
registerPlugin(agentStatusPlugin);
registerPlugin(projectBuilderPlugin);

export { todayBriefPlugin, approvalQueuePlugin, agentStatusPlugin, projectBuilderPlugin };
