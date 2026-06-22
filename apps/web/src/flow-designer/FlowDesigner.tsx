import React, { useMemo, useState, useRef } from 'react';
import type { Node } from 'reactflow';
import type { Edge } from 'reactflow';
import { Braces, CheckSquare, CircleCheck, Clock, Diamond, Inbox, PanelRightClose, PanelRightOpen, Play, Search, Star } from 'lucide-react';
import { Button } from '../components/Button';
import { Header } from '../components/Header';
import { Input } from '../components/Input';
import { FlowCanvas } from './FlowCanvas';
import type { FlowCanvasRef } from './FlowCanvas';
import type { CustomNodeData, FormSchema } from './form-types';
import { NodePropertiesForm } from './NodePropertiesForm';
import type { NodePathSuggestion } from './NodePropertiesForm';
import { TemplateListModal } from './TemplateListModal';
import { ExecutionModal } from './ExecutionModal';
import { ExecutionPanel } from './ExecutionPanel';
import { HistoryListModal } from './HistoryListModal';
import { templatesApi } from '../api/templates';
import type { WorkflowTemplate } from '../api/templates';
import { pluginsApi } from '../api/plugins';
import type { PluginManifest, PluginTestResponse } from '../api/plugins';
import { PluginIcon } from './plugin-icons';
import './FlowDesigner.css';

export interface FlowDesignerProps {
  children?: React.ReactNode;
  onSwitchToInbox?: () => void;
  initialMonitorInstanceId?: string;
}

export const FlowDesigner: React.FC<FlowDesignerProps> = ({ onSwitchToInbox, initialMonitorInstanceId }) => {
  const [darkMode, setDarkMode] = useState(true);
  const [selectedNode, setSelectedNode] = useState<Node<CustomNodeData> | null>(null);
  const [canvasNodes, setCanvasNodes] = useState<Node<CustomNodeData>[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<Edge[]>([]);
  const [currentTemplateId, setCurrentTemplateId] = useState<string | null>(null);
  const [currentTemplateName, setCurrentTemplateName] = useState<string>('');
  const [workflowDescription, setWorkflowDescription] = useState('');
  const [workflowGroup, setWorkflowGroup] = useState('');
  const [workflowTags, setWorkflowTags] = useState('');
  const [workflowVersionNote, setWorkflowVersionNote] = useState('');
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isExecutionModalOpen, setIsExecutionModalOpen] = useState(false);
  const [isExecutionPanelOpen, setIsExecutionPanelOpen] = useState(false);
  const [isPropertiesPanelOpen, setIsPropertiesPanelOpen] = useState(true);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [executionInstanceId, setExecutionInstanceId] = useState<string | null>(null);
  const [executionFormSchema, setExecutionFormSchema] = useState<FormSchema | undefined>(undefined);
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [pluginSearch, setPluginSearch] = useState('');
  const [isNodeTestRunning, setIsNodeTestRunning] = useState(false);
  const [nodeTestResult, setNodeTestResult] = useState<PluginTestResponse | null>(null);
  const [nodeTestError, setNodeTestError] = useState<string | null>(null);
  const [favoritePluginIds, setFavoritePluginIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('pxm.favoritePlugins') || '[]');
    } catch {
      return [];
    }
  });
  const flowCanvasRef = useRef<FlowCanvasRef>(null);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const eventQueueRef = useRef<Array<{nodeId: string, status: 'pending' | 'running' | 'completed' | 'failed'}>>([]); 
  const isProcessingRef = useRef(false);

  // SSE 연결 정리
  React.useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    pluginsApi
      .list()
      .then((items) => {
        if (!cancelled) {
          setPlugins(items);
        }
      })
      .catch((error) => {
        console.error('Failed to load plugins:', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 실시간 추적 인스턴스 전이 연동
  React.useEffect(() => {
    if (initialMonitorInstanceId) {
      console.log('Restoring instance for real-time tracking:', initialMonitorInstanceId);
      handleHistorySelect(initialMonitorInstanceId);
    }
  }, [initialMonitorInstanceId]);

  const handleRun = async (formData?: Record<string, any>) => {
    if (!currentTemplateId) {
      alert('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    // formData가 없으면 Start 노드에 폼이 있는지 확인
    if (!formData) {
      const nodes = flowCanvasRef.current?.getNodes() || [];
      const startNode = nodes.find(n => n.data.nodeType === 'start');
      
      if (startNode?.data.formSchema && startNode.data.formSchema.fields.length > 0) {
        // 폼이 있으면 실행 모달을 열어서 폼을 먼저 표시
        setExecutionFormSchema(JSON.parse(JSON.stringify(startNode.data.formSchema)));
        setExecutionInstanceId(null); // 아직 실행 전
        setIsExecutionModalOpen(true);
        return;
      }
    }

    try {
      // formData 정리 (circular reference 제거)
      let cleanFormData: Record<string, any> | undefined = undefined;
      if (formData) {
        cleanFormData = {};
        Object.keys(formData).forEach(key => {
          const value = formData[key];
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
            cleanFormData![key] = value;
          } else if (Array.isArray(value)) {
            cleanFormData![key] = value.filter(v => 
              typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
            );
          }
        });
      }
      
      const result = await templatesApi.execute(currentTemplateId, cleanFormData);
      
      setExecutionInstanceId(result.instance_id);
      // 실행 시작 후에는 패널로 표시
      setIsExecutionModalOpen(false);
      setIsExecutionPanelOpen(true);
      setIsPropertiesPanelOpen(true);
      
      connectSSE(result.instance_id);
      console.log('Workflow execution started:', result);
    } catch (error) {
      console.error('Failed to execute workflow:', error);
      alert('워크플로우 실행에 실패했습니다.');
    }
  };

  const connectSSE = (instanceId: string) => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // 상대 경로 /api/instances/... 사용
    const eventSource = new EventSource(`/api/instances/${instanceId}/stream`);
    eventSourceRef.current = eventSource;

    const handleEvent = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        console.log('SSE Event (Canvas):', data);

        const nodes = flowCanvasRef.current?.getNodes() || [];
        let targetNodeId = data.node_id || data.payload?.node_id;

        // ID 불일치 대응: 이벤트의 노드 ID가 캔버스에 없으면, 실행 중인 노드를 찾아 매핑
        if (targetNodeId && !nodes.find(n => n.id === targetNodeId)) {
          if (data.type === 'NODE_FAILED' || data.type === 'NODE_COMPLETED') {
            // 1. 실행 중인 노드 찾기
            let fallbackNode = nodes.find(n => n.data.executionStatus === 'running');

            // 2. 타입 기반 추론 (targetNodeId에 타입 이름이 포함된 경우)
            if (!fallbackNode && typeof targetNodeId === 'string') {
              const lowerId = targetNodeId.toLowerCase();
              let typeToSearch = '';
              if (lowerId.includes('service')) typeToSearch = 'service';
              else if (lowerId.includes('timer')) typeToSearch = 'timer';
              else if (lowerId.includes('gateway')) typeToSearch = 'gateway';

              if (typeToSearch) {
                const candidates = nodes.filter(n => n.data.nodeType === typeToSearch);
                // 해당 타입의 노드가 딱 하나만 있을 때만 매칭 (오탐 방지)
                if (candidates.length === 1) {
                  fallbackNode = candidates[0];
                }
              }
            }

            if (fallbackNode) {
              console.warn(`Node ID mismatch: event node_id=${targetNodeId} not found, using fallback node=${fallbackNode.id}`);
              targetNodeId = fallbackNode.id;
            }
          }
        }

        if (data.type === 'NODE_STARTED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'running');
        } else if (data.type === 'NODE_COMPLETED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'completed');
        } else if (data.type === 'NODE_FAILED' && targetNodeId) {
          updateNodeExecutionStatus(targetNodeId, 'failed');
        }

        if (data.type === 'INSTANCE_COMPLETED' || data.type === 'INSTANCE_FAILED') {
          setTimeout(() => {
            eventSource.close();
          }, 1000);
        }
      } catch (err) {
        console.error('Failed to parse SSE event:', err);
      }
    };

    const eventTypes = [
      'INSTANCE_CREATED', 'INSTANCE_RUNNING', 'INSTANCE_WAITING', 'INSTANCE_COMPLETED', 'INSTANCE_FAILED',
      'NODE_STARTED', 'NODE_COMPLETED', 'NODE_FAILED',
      'TIMER_SCHEDULED', 'TIMER_ESCALATED', 'RETRY_SCHEDULED', 'APPROVAL_REQUIRED',
    ];

    eventTypes.forEach((eventType) => {
      eventSource.addEventListener(eventType, handleEvent);
    });

    eventSource.onmessage = handleEvent;
    eventSource.onerror = (err) => {
      console.error('SSE Error:', err);
      eventSource.close();
    };
  };

  // 이벤트 큐 처리
  const processEventQueue = React.useCallback(() => {
    if (isProcessingRef.current || eventQueueRef.current.length === 0) {
      return;
    }

    isProcessingRef.current = true;
    const event = eventQueueRef.current.shift()!;
    const { nodeId, status } = event;

    if (status === 'completed') {
      // 1. 엣지 애니메이션 시작
      flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, 'running');
      
      // 2. 1.2초 후 노드 완료 표시
      setTimeout(() => {
        flowCanvasRef.current?.updateNodeData(nodeId, { executionStatus: status });
        flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, status);
        
        // 3. 약간의 여유 시간 후 다음 이벤트 처리
        setTimeout(() => {
          isProcessingRef.current = false;
          processEventQueue();
        }, 300); // 다음 노드 시작 전 짧은 대기
      }, 1200);
    } else {
      // running, failed 등은 즉시 처리
      flowCanvasRef.current?.updateNodeData(nodeId, { executionStatus: status });
      flowCanvasRef.current?.updateEdgesByNodeStatus(nodeId, status);
      
      setTimeout(() => {
        isProcessingRef.current = false;
        processEventQueue();
      }, 100);
    }
  }, []);

  const updateNodeExecutionStatus = React.useCallback((nodeId: string, status: 'pending' | 'running' | 'completed' | 'failed') => {
    // 이벤트를 큐에 추가
    eventQueueRef.current.push({ nodeId, status });
    processEventQueue();
  }, [processEventQueue]);

  const handleSave = async () => {
    const nodes = flowCanvasRef.current?.getNodes() || [];
    const edges = flowCanvasRef.current?.getEdges() || [];

    const templateName = prompt('템플릿 이름을 입력하세요:', currentTemplateName || 'New Workflow');
    if (!templateName) return;

    try {
      if (currentTemplateId) {
        const updated = await templatesApi.update(currentTemplateId, {
          name: templateName,
          description: workflowDescription,
          group: workflowGroup,
          tags: parseTagList(workflowTags),
          version_note: workflowVersionNote,
          nodes,
          edges,
        });
        setCurrentTemplateName(updated.name);
        alert(`템플릿이 업데이트되었습니다: ${updated.name} (v${updated.version})`);
      } else {
        const created = await templatesApi.create({
          name: templateName,
          description: workflowDescription,
          group: workflowGroup,
          tags: parseTagList(workflowTags),
          version_note: workflowVersionNote,
          nodes,
          edges,
        });
        setCurrentTemplateId(created.id);
        setCurrentTemplateName(created.name);
        alert(`템플릿이 저장되었습니다: ${created.name}`);
      }
    } catch (error) {
      console.error('Failed to save template:', error);
      alert('템플릿 저장에 실패했습니다.');
    }
  };

  const handleLoad = () => {
    setIsTemplateModalOpen(true);
  };

  const handleExport = async () => {
    if (!currentTemplateId) {
      alert('먼저 템플릿을 저장하거나 불러와주세요.');
      return;
    }

    try {
      const document = await templatesApi.export(currentTemplateId);
      downloadJson(document, `${safeFileName(document.workflow.name)}.pxm-workflow.json`);
    } catch (error) {
      console.error('Failed to export workflow:', error);
      alert('워크플로우 내보내기에 실패했습니다.');
    }
  };

  const handleImport = () => {
    importFileInputRef.current?.click();
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const document = JSON.parse(text);
      const imported = await templatesApi.import(document);
      handleTemplateSelect(imported);
      alert(`워크플로우를 가져왔습니다: ${imported.name}`);
    } catch (error) {
      console.error('Failed to import workflow:', error);
      alert(error instanceof Error ? `워크플로우 가져오기에 실패했습니다: ${error.message}` : '워크플로우 가져오기에 실패했습니다.');
    }
  };

  const handleHistory = () => {
    setIsHistoryModalOpen(true);
  };

  const handleTemplateSelect = (template: WorkflowTemplate) => {
    flowCanvasRef.current?.setNodesAndEdges(template.nodes, template.edges);
    setCurrentTemplateId(template.id);
    setCurrentTemplateName(template.name);
    setWorkflowDescription(template.description || '');
    setWorkflowGroup(template.group || '');
    setWorkflowTags((template.tags || []).join(', '));
    setWorkflowVersionNote(template.version_note || '');
    alert(`템플릿 "${template.name}"을 불러왔습니다.`);
  };

  const handleHistorySelect = async (instanceId: string) => {
    try {
      // 1. 인스턴스 상세 정보 조회 (ctx 복원을 위해)
      const res = await fetch(`/api/instances/${instanceId}`);
      if (!res.ok) throw new Error('Failed to fetch instance details');
      const instance = await res.json();
      
      // ctx에서 nodes/edges 복원
      const runtimeContext = instance.ctx?.runtime || instance.context?.runtime || instance.ctx || instance.context;
      if (runtimeContext && runtimeContext.nodes && runtimeContext.edges) {
        flowCanvasRef.current?.setNodesAndEdges(runtimeContext.nodes, runtimeContext.edges);
        
        // 템플릿 정보도 업데이트 (선택 사항)
        if (instance.template_id) {
          setCurrentTemplateId(instance.template_id);
          // 템플릿 이름은 별도로 가져오거나 instance 정보에 없다면 스킵
        }
      }
      
      // 2. 실행 상태 패널 열기 및 SSE 연결
      setExecutionInstanceId(instanceId);
      setIsExecutionPanelOpen(true);
      setIsPropertiesPanelOpen(true);
      connectSSE(instanceId);
      setIsHistoryModalOpen(false);
      
    } catch (error) {
      console.error('Failed to restore history:', error);
      alert('실행 이력을 불러오는 데 실패했습니다.');
    }
  };

  const handleSettings = () => {
    setSelectedNode(null);
    setIsExecutionPanelOpen(false);
    setIsPropertiesPanelOpen(true);
  };

  const handleToggleDarkMode = () => {
    setDarkMode(!darkMode);
  };

  const handleNodeSelect = (node: Node | null) => {
    if (node?.id !== selectedNode?.id) {
      setNodeTestResult(null);
      setNodeTestError(null);
    }
    setSelectedNode(node as Node<CustomNodeData> | null);
    if (node) {
      setIsPropertiesPanelOpen(true);
      return;
    }

    if (!isExecutionPanelOpen) {
      setIsPropertiesPanelOpen(false);
    }
  };

  const handleNodeUpdate = (nodeId: string, data: Partial<CustomNodeData>) => {
    flowCanvasRef.current?.updateNodeData(nodeId, data);
  };

  const handleGatewayEdgeUpdate = (edgeId: string, data: Partial<Edge>) => {
    flowCanvasRef.current?.updateEdgeData(edgeId, data);
  };

  const handleSelectedNodeTest = async () => {
    if (!selectedNode || selectedNode.data.nodeType !== 'service') {
      return;
    }

    const pluginId = selectedNode.data.plugin_id || CORE_PLUGIN_ID;
    setIsNodeTestRunning(true);
    setNodeTestResult(null);
    setNodeTestError(null);

    try {
      const result = await pluginsApi.test({
        plugin_id: pluginId,
        node_id: selectedNode.id,
        config: selectedNode.data as unknown as Record<string, unknown>,
        input: {},
      });
      setNodeTestResult(result);
      if (!result.ok) {
        setNodeTestError(result.error || '테스트 실행에 실패했습니다.');
      }
    } catch (error) {
      setNodeTestError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsNodeTestRunning(false);
    }
  };

  const onDragStart = (event: React.DragEvent, nodeType: string, label: string, extraData?: Partial<CustomNodeData>) => {
    const nodeData: CustomNodeData = {
      label,
      nodeType: nodeType as CustomNodeData['nodeType'],
      description: `${label} 노드`,
      ...extraData,
    };
    event.dataTransfer.setData('application/reactflow', JSON.stringify(nodeData));
    event.dataTransfer.effectAllowed = 'move';
  };

  const onPluginDragStart = (event: React.DragEvent, plugin: PluginManifest) => {
    const defaults = getPluginConfigDefaults(plugin);
    onDragStart(event, 'service', plugin.display_name, {
      ...defaults,
      description: plugin.description || plugin.category,
      plugin_id: plugin.plugin_id,
      plugin_version: plugin.version,
      icon: plugin.icon,
      category: plugin.category,
      timeout: plugin.timeout_ms,
      retryCount: plugin.retry_policy?.max_attempts,
      enableRetry: !!plugin.retry_policy?.max_attempts,
    });
  };

  const toggleFavoritePlugin = (pluginId: string) => {
    setFavoritePluginIds((current) => {
      const next = current.includes(pluginId)
        ? current.filter((id) => id !== pluginId)
        : [...current, pluginId];
      localStorage.setItem('pxm.favoritePlugins', JSON.stringify(next));
      return next;
    });
  };

  const filteredPlugins = useMemo(() => {
    const query = pluginSearch.trim().toLowerCase();
    return plugins.filter((plugin) => {
      if (!query) return true;
      return [
        plugin.display_name,
        plugin.plugin_id,
        plugin.category,
        ...(plugin.tags || []),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [plugins, pluginSearch]);

  const favoritePlugins = useMemo(
    () => filteredPlugins.filter((plugin) => plugin.plugin_id !== CORE_PLUGIN_ID && favoritePluginIds.includes(plugin.plugin_id)),
    [filteredPlugins, favoritePluginIds],
  );

  const pluginsByCategory = useMemo(() => {
    return filteredPlugins.reduce<Record<string, PluginManifest[]>>((groups, plugin) => {
      if (plugin.plugin_id === CORE_PLUGIN_ID || favoritePluginIds.includes(plugin.plugin_id)) {
        return groups;
      }
      const category = plugin.category || 'Other';
      groups[category] = groups[category] || [];
      groups[category].push(plugin);
      return groups;
    }, {});
  }, [filteredPlugins, favoritePluginIds]);

  const selectedGatewayEdges = useMemo(() => {
    if (!selectedNode || selectedNode.data.nodeType !== 'gateway') {
      return [];
    }
    return canvasEdges.filter((edge) => edge.source === selectedNode.id);
  }, [canvasEdges, selectedNode]);

  const selectedNodePathSuggestions = useMemo(() => {
    if (!selectedNode) {
      return [];
    }
    return buildPreviousNodePathSuggestions(selectedNode, canvasNodes, canvasEdges, plugins);
  }, [canvasEdges, canvasNodes, plugins, selectedNode]);

  return (
    <div className="flow-designer">
      <Header
        title="PXM Flow Designer"
        actions={
          <Button variant="ghost" icon={<Inbox />} onClick={() => onSwitchToInbox?.()}>
            내 결재함
          </Button>
        }
        onRun={() => handleRun()}
        onSave={handleSave}
        onLoad={handleLoad}
        onImport={handleImport}
        onExport={handleExport}
        onHistory={handleHistory}
        onSettings={handleSettings}
        darkMode={darkMode}
        onToggleDarkMode={handleToggleDarkMode}
      />
      <input
        ref={importFileInputRef}
        type="file"
        accept="application/json,.json,.pxm-workflow.json"
        className="workflow-import-input"
        onChange={handleImportFileChange}
      />

      <div className={`flow-designer-content${isPropertiesPanelOpen ? '' : ' properties-collapsed'}`}>
        <aside className="node-palette">
          <div className="palette-header">
            <h3 className="palette-title">노드 팔레트</h3>
          </div>
          <div className="palette-content">
            <div className="palette-section">
              <h4 className="palette-section-title">기본 노드</h4>
              <div className="palette-nodes">
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'start', 'Start')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-start)' }}><Play size={16} fill="currentColor" /></div>
                  <span className="palette-node-label">Start</span>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'timer', 'Timer')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-timer)' }}><Clock size={16} /></div>
                  <span className="palette-node-label">Timer</span>
                </div>
                <div
                  className="palette-node"
                  draggable
                  onDragStart={(e) =>
                    onDragStart(e, 'script', 'JS Node', {
                      scriptType: 'javascript',
                      code: "return { message: 'hello from js node', formData: input.formData };",
                      outputPath: 'scriptResults.jsNode',
                      scriptTimeoutMs: 1000,
                    })
                  }
                >
                  <div className="palette-node-icon" style={{ background: 'var(--node-script)' }}><Braces size={16} /></div>
                  <span className="palette-node-label">JS Node</span>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'gateway', 'Gateway')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-gateway)' }}><Diamond size={16} fill="currentColor" /></div>
                  <span className="palette-node-label">Gateway</span>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'approval', 'Approval')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-approval)' }}><CheckSquare size={16} /></div>
                  <span className="palette-node-label">Approval</span>
                </div>
                <div className="palette-node" draggable onDragStart={(e) => onDragStart(e, 'end', 'End')}>
                  <div className="palette-node-icon" style={{ background: 'var(--node-end)' }}><CircleCheck size={16} /></div>
                  <span className="palette-node-label">End</span>
                </div>
              </div>
            </div>

            <div className="palette-section">
              <h4 className="palette-section-title">플러그인 노드</h4>
              <div className="palette-search">
                <Search size={14} />
                <input
                  value={pluginSearch}
                  onChange={(event) => setPluginSearch(event.target.value)}
                  placeholder="Search plugins"
                />
              </div>
              {favoritePlugins.length > 0 && (
                <PluginPaletteSection
                  title="Favorites"
                  plugins={favoritePlugins}
                  favoritePluginIds={favoritePluginIds}
                  onDragStart={onPluginDragStart}
                  onToggleFavorite={toggleFavoritePlugin}
                />
              )}
              <PluginPaletteSection
                title="Core"
                plugins={getCorePlugins(filteredPlugins)}
                favoritePluginIds={favoritePluginIds}
                onDragStart={onPluginDragStart}
                onToggleFavorite={toggleFavoritePlugin}
              />
              {Object.entries(pluginsByCategory).map(([category, categoryPlugins]) => (
                <PluginPaletteSection
                  key={category}
                  title={category}
                  plugins={categoryPlugins}
                  favoritePluginIds={favoritePluginIds}
                  onDragStart={onPluginDragStart}
                  onToggleFavorite={toggleFavoritePlugin}
                />
              ))}
            </div>
          </div>
        </aside>

        <main className="canvas">
          <FlowCanvas
            ref={flowCanvasRef}
            onNodeSelect={handleNodeSelect}
            onNodesChange={(nodes) => setCanvasNodes(nodes as Node<CustomNodeData>[])}
            onEdgesChange={setCanvasEdges}
          />
        </main>

        <aside className={`properties-panel${isPropertiesPanelOpen ? '' : ' collapsed'}`}>
          {isExecutionPanelOpen ? (
            <ExecutionPanel
              instanceId={executionInstanceId}
              templateName={currentTemplateName}
              formSchema={executionFormSchema}
              onFormSubmit={(formData) => handleRun(formData)}
              onClose={() => {
                setIsExecutionPanelOpen(false);
                setExecutionInstanceId(null);
                setExecutionFormSchema(undefined);
              }}
            />
          ) : (
            <>
              <div className="properties-header">
                <div className="properties-title-group">
                  <h3 className="properties-title">속성 패널</h3>
                  {selectedNode && (
                    <span className="properties-subtitle">{selectedNode.data.label}</span>
                  )}
                </div>
                <button
                  type="button"
                  className="properties-toggle-button"
                  onClick={() => setIsPropertiesPanelOpen((current) => !current)}
                  aria-label={isPropertiesPanelOpen ? '속성 패널 접기' : '속성 패널 펼치기'}
                  title={isPropertiesPanelOpen ? '속성 패널 접기' : '속성 패널 펼치기'}
                >
                  {isPropertiesPanelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
                </button>
              </div>
              {isPropertiesPanelOpen && (
                <div className="properties-content">
                  {selectedNode ? (
                    <NodePropertiesForm
                      node={selectedNode}
                      onUpdate={handleNodeUpdate}
                    plugins={plugins}
                    gatewayEdges={selectedGatewayEdges}
                    pathSuggestions={selectedNodePathSuggestions}
                    onGatewayEdgeUpdate={handleGatewayEdgeUpdate}
                    onTestRun={handleSelectedNodeTest}
                    testRunning={isNodeTestRunning}
                    testResult={nodeTestResult}
                    testError={nodeTestError}
                  />
                  ) : (
                    <WorkflowMetadataForm
                      description={workflowDescription}
                      group={workflowGroup}
                      tags={workflowTags}
                      versionNote={workflowVersionNote}
                      onDescriptionChange={setWorkflowDescription}
                      onGroupChange={setWorkflowGroup}
                      onTagsChange={setWorkflowTags}
                      onVersionNoteChange={setWorkflowVersionNote}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </aside>
      </div>

      <TemplateListModal
        isOpen={isTemplateModalOpen}
        onClose={() => setIsTemplateModalOpen(false)}
        onSelect={handleTemplateSelect}
      />

      <HistoryListModal
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        onSelect={handleHistorySelect}
      />

      <ExecutionModal
        isOpen={isExecutionModalOpen}
        instanceId={executionInstanceId}
        templateName={currentTemplateName}
        formSchema={executionFormSchema}
        onFormSubmit={(formData) => handleRun(formData)}
        onClose={() => setIsExecutionModalOpen(false)}
      />
    </div>
  );
};

const CORE_PLUGIN_ID = 'builtin.http_request';

function getCorePlugins(plugins: PluginManifest[]) {
  return plugins.filter((plugin) => plugin.plugin_id === CORE_PLUGIN_ID);
}

function getPluginConfigDefaults(plugin: PluginManifest): Partial<CustomNodeData> {
  const defaults: Record<string, unknown> = {};
  Object.entries(plugin.config_schema.properties || {}).forEach(([key, property]) => {
    if (property.default !== undefined) {
      defaults[key] = property.default;
    }
  });
  return defaults as Partial<CustomNodeData>;
}

function buildPreviousNodePathSuggestions(
  selectedNode: Node<CustomNodeData>,
  nodes: Node<CustomNodeData>[],
  edges: Edge[],
  plugins: PluginManifest[],
): NodePathSuggestion[] {
  const incomingEdges = edges.filter((edge) => edge.target === selectedNode.id);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const suggestions: NodePathSuggestion[] = [];

  for (const edge of incomingEdges) {
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode) {
      continue;
    }
    suggestions.push(...buildNodeOutputSuggestions(sourceNode, plugins));
  }

  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = `${suggestion.sourceNodeId}:${suggestion.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNodeOutputSuggestions(
  node: Node<CustomNodeData>,
  plugins: PluginManifest[],
): NodePathSuggestion[] {
  const data = node.data as Record<string, any>;
  const sourceNodeLabel = node.data.label || node.id;

  if (node.data.nodeType === 'start') {
    const fields = node.data.formSchema?.fields || [];
    return fields.map((field) => ({
      label: `${sourceNodeLabel} · ${field.label || field.id}`,
      path: `data.formData.${field.id}`,
      sourceNodeId: node.id,
      sourceNodeLabel,
    }));
  }

  const outputPath = getConfiguredOutputPath(data, node);
  if (!outputPath) {
    return [];
  }

  const baseSuggestion: NodePathSuggestion = {
    label: `${sourceNodeLabel} · output`,
    path: outputPath,
    sourceNodeId: node.id,
    sourceNodeLabel,
  };

  if (node.data.nodeType === 'script') {
    return [baseSuggestion];
  }

  if (node.data.nodeType !== 'service') {
    return [];
  }

  const plugin = plugins.find((item) => item.plugin_id === data.plugin_id);
  const schemaProperties = plugin?.output_schema?.properties || {};
  const schemaPaths = Object.keys(schemaProperties).map((key) => ({
    label: `${sourceNodeLabel} · ${key}`,
    path: `${outputPath}.${key}`,
    sourceNodeId: node.id,
    sourceNodeLabel,
  }));

  return [baseSuggestion, ...schemaPaths];
}

function getConfiguredOutputPath(data: Record<string, any>, node: Node<CustomNodeData>) {
  const value = data.outputPath || data.output_path;
  if (typeof value === 'string' && value.trim()) {
    return normalizeContextPath(value);
  }
  if (node.data.nodeType === 'script') {
    return `scriptResults.${node.id}`;
  }
  return '';
}

function normalizeContextPath(path: string) {
  return path.trim().replace(/^context\./, '');
}

function parseTagList(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  const trimmed = value.trim().replace(/[^a-zA-Z0-9가-힣._-]+/g, '-').replace(/^-+|-+$/g, '');
  return trimmed || 'workflow';
}

function WorkflowMetadataForm({
  description,
  group,
  tags,
  versionNote,
  onDescriptionChange,
  onGroupChange,
  onTagsChange,
  onVersionNoteChange,
}: {
  description: string;
  group: string;
  tags: string;
  versionNote: string;
  onDescriptionChange: (value: string) => void;
  onGroupChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onVersionNoteChange: (value: string) => void;
}) {
  return (
    <div className="workflow-metadata-form">
      <div className="property-section">
        <h4 className="property-section-title">워크플로우 메타데이터</h4>
        <div className="property-group">
          <label className="property-label">Description</label>
          <textarea
            className="property-textarea"
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="워크플로우 목적과 사용 조건"
            rows={4}
          />
        </div>
        <Input
          label="Group"
          value={group}
          onChange={(event) => onGroupChange(event.target.value)}
          placeholder="예: HR, IT, Finance"
          fullWidth
        />
        <Input
          label="Tags"
          value={tags}
          onChange={(event) => onTagsChange(event.target.value)}
          placeholder="approval, onboarding, account"
          helperText="쉼표로 구분합니다."
          fullWidth
        />
        <div className="property-group">
          <label className="property-label">Version Note</label>
          <textarea
            className="property-textarea"
            value={versionNote}
            onChange={(event) => onVersionNoteChange(event.target.value)}
            placeholder="이번 버전의 변경 내용"
            rows={3}
          />
        </div>
      </div>
    </div>
  );
}

function PluginPaletteSection({
  title,
  plugins,
  favoritePluginIds,
  onDragStart,
  onToggleFavorite,
}: {
  title: string;
  plugins: PluginManifest[];
  favoritePluginIds: string[];
  onDragStart: (event: React.DragEvent, plugin: PluginManifest) => void;
  onToggleFavorite: (pluginId: string) => void;
}) {
  return (
    <div className="plugin-category">
      <h5 className="plugin-category-title">{title}</h5>
      <div className="palette-nodes">
        {plugins.map((plugin) => {
          const isFavorite = favoritePluginIds.includes(plugin.plugin_id);
          return (
            <div
              key={plugin.plugin_id}
              className="palette-node plugin-palette-node"
              draggable
              onDragStart={(event) => onDragStart(event, plugin)}
            >
              <div className="palette-node-icon plugin-node-icon">
                <PluginIcon icon={plugin.icon} size={16} />
              </div>
              <div className="palette-node-text">
                <span className="palette-node-label">{plugin.display_name}</span>
                <span className="palette-node-caption">{plugin.executor_type}</span>
              </div>
              <button
                type="button"
                className={`favorite-plugin-button ${isFavorite ? 'active' : ''}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleFavorite(plugin.plugin_id);
                }}
                title={isFavorite ? 'Remove favorite' : 'Add favorite'}
              >
                <Star size={13} fill={isFavorite ? 'currentColor' : 'none'} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
