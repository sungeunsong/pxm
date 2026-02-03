import { FlowDesigner } from './flow-designer/FlowDesigner';
import { InboxPage } from './inbox/InboxPage';

function App() {
  const path = window.location.pathname;
  const isInbox = path === '/inbox';

  return (
    <>
      <div style={{ display: isInbox ? 'none' : 'block', height: '100vh' }}>
        <FlowDesigner />
      </div>
      {isInbox && <InboxPage />}
    </>
  );
}

export default App;
