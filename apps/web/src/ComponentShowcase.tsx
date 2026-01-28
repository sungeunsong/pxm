import React, { useState } from 'react';
import { Play, Settings, Clock, Save, Trash2, Search, Mail, User } from 'lucide-react';
import { Button, Panel, Input, Select, Checkbox } from './components';
import './ComponentShowcase.css';

export const ComponentShowcase: React.FC = () => {
  const [email, setEmail] = useState('');
  const [nodeType, setNodeType] = useState('');
  const [agree, setAgree] = useState(false);

  return (
    <div className="showcase">
      <div className="showcase-header">
        <h1>PXM 디자인 시스템</h1>
        <p className="text-secondary">Total.js Flow 스타일 컴포넌트</p>
      </div>

      <div className="showcase-grid">
        {/* Button Showcase */}
        <Panel title="버튼" subtitle="4가지 스타일 × 3가지 크기">
          <div className="component-section">
            <h4 className="section-title">버튼 스타일</h4>
            <div className="button-group">
              <Button variant="primary" icon={<Play />}>
                Primary
              </Button>
              <Button variant="secondary" icon={<Settings />}>
                Secondary
              </Button>
              <Button variant="ghost" icon={<Clock />}>
                Ghost
              </Button>
              <Button variant="danger" icon={<Trash2 />}>
                Danger
              </Button>
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">버튼 크기</h4>
            <div className="button-group">
              <Button size="sm" icon={<Save />}>
                Small
              </Button>
              <Button size="md" icon={<Save />}>
                Medium
              </Button>
              <Button size="lg" icon={<Save />}>
                Large
              </Button>
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">아이콘 위치</h4>
            <div className="button-group">
              <Button icon={<Play />} iconPosition="left">
                Icon Left
              </Button>
              <Button icon={<Play />} iconPosition="right">
                Icon Right
              </Button>
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">비활성화</h4>
            <div className="button-group">
              <Button variant="primary" disabled>
                Disabled
              </Button>
              <Button variant="secondary" disabled>
                Disabled
              </Button>
            </div>
          </div>
        </Panel>

        {/* Input Showcase */}
        <Panel title="입력 필드" subtitle="텍스트 입력 컴포넌트">
          <div className="component-section">
            <h4 className="section-title">기본 입력</h4>
            <div className="form-grid">
              <Input
                label="이름"
                placeholder="Enter your name"
                fullWidth
              />
              <Input
                label="이메일"
                type="email"
                placeholder="email@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                helperText="Please enter a valid email address"
                fullWidth
              />
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">아이콘 포함</h4>
            <div className="form-grid">
              <Input
                label="검색"
                placeholder="Search..."
                leftIcon={<Search />}
                fullWidth
              />
              <Input
                label="사용자 이메일"
                type="email"
                placeholder="user@example.com"
                leftIcon={<Mail />}
                rightIcon={<User />}
                fullWidth
              />
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">크기 및 상태</h4>
            <div className="form-grid">
              <Input
                size="sm"
                placeholder="Small input"
                fullWidth
              />
              <Input
                size="lg"
                placeholder="Large input"
                fullWidth
              />
              <Input
                label="필수 입력"
                placeholder="Required field"
                required
                fullWidth
              />
              <Input
                label="에러 상태"
                placeholder="Invalid input"
                error="Please enter a valid value"
                fullWidth
              />
            </div>
          </div>
        </Panel>

        {/* Select Showcase */}
        <Panel title="선택 필드" subtitle="드롭다운 선택 컴포넌트">
          <div className="component-section">
            <h4 className="section-title">기본 선택</h4>
            <div className="form-grid">
              <Select
                label="노드 타입"
                placeholder="Select node type"
                value={nodeType}
                onChange={(e) => setNodeType(e.target.value)}
                options={[
                  { value: 'start', label: 'Start Node' },
                  { value: 'service', label: 'Service Node' },
                  { value: 'timer', label: 'Timer Node' },
                  { value: 'gateway', label: 'Gateway Node' },
                  { value: 'approval', label: 'Approval Node' },
                  { value: 'end', label: 'End Node' },
                ]}
                fullWidth
              />
              <Select
                label="우선순위"
                placeholder="Select priority"
                options={[
                  { value: 'high', label: 'High' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'low', label: 'Low' },
                ]}
                helperText="Select task priority"
                fullWidth
              />
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">크기 및 상태</h4>
            <div className="form-grid">
              <Select
                size="sm"
                placeholder="Small select"
                options={[
                  { value: '1', label: 'Option 1' },
                  { value: '2', label: 'Option 2' },
                ]}
                fullWidth
              />
              <Select
                size="lg"
                placeholder="Large select"
                options={[
                  { value: '1', label: 'Option 1' },
                  { value: '2', label: 'Option 2' },
                ]}
                fullWidth
              />
              <Select
                label="에러 상태"
                placeholder="Select..."
                options={[
                  { value: '1', label: 'Option 1' },
                ]}
                error="This field is required"
                fullWidth
              />
            </div>
          </div>
        </Panel>

        {/* Checkbox Showcase */}
        <Panel title="체크박스" subtitle="선택 옵션 컴포넌트">
          <div className="component-section">
            <h4 className="section-title">기본 체크박스</h4>
            <div className="checkbox-group">
              <Checkbox
                label="I agree to the terms and conditions"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
              />
              <Checkbox
                label="I agree to receive marketing emails (optional)"
              />
              <Checkbox
                label="I agree to the privacy policy"
                helperText="This is a required field"
              />
            </div>
          </div>

          <div className="component-section">
            <h4 className="section-title">크기 및 상태</h4>
            <div className="checkbox-group">
              <Checkbox
                size="sm"
                label="Small checkbox"
              />
              <Checkbox
                size="lg"
                label="Large checkbox"
              />
              <Checkbox
                label="Disabled checkbox"
                disabled
              />
              <Checkbox
                label="Checked and disabled"
                checked
                disabled
              />
              <Checkbox
                label="Error state"
                error="This field is required"
              />
            </div>
          </div>
        </Panel>

        {/* Panel Showcase */}
        <Panel title="패널" subtitle="접을 수 있는 컨테이너">
          <div className="component-section">
            <Panel
              title="기본 패널"
              subtitle="부제목 포함"
              collapsible
            >
              <p className="text-secondary">
                This is a basic panel with a title, subtitle, and collapsible functionality.
              </p>
            </Panel>
          </div>

          <div className="component-section">
            <Panel
              title="액션 버튼이 있는 패널"
              actions={
                <>
                  <Button size="sm" variant="ghost" icon={<Settings />}>
                    Settings
                  </Button>
                  <Button size="sm" variant="primary" icon={<Save />}>
                    Save
                  </Button>
                </>
              }
              collapsible
            >
              <p className="text-secondary">
                This panel has action buttons in the header.
              </p>
            </Panel>
          </div>

          <div className="component-section">
            <Panel
              title="기본으로 접힌 패널"
              collapsible
              defaultCollapsed
            >
              <p className="text-secondary">
                This panel starts collapsed by default.
              </p>
            </Panel>
          </div>
        </Panel>

        {/* Colors Showcase */}
        <Panel title="노드 색상" subtitle="워크플로우 노드 색상 시스템">
          <div className="color-grid">
            <div className="color-card" style={{ '--node-color': 'var(--node-start)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">Start</span>
                <span className="color-hex">#4caf50</span>
              </div>
            </div>
            <div className="color-card" style={{ '--node-color': 'var(--node-service)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">Service</span>
                <span className="color-hex">#2196f3</span>
              </div>
            </div>
            <div className="color-card" style={{ '--node-color': 'var(--node-timer)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">Timer</span>
                <span className="color-hex">#ff9800</span>
              </div>
            </div>
            <div className="color-card" style={{ '--node-color': 'var(--node-gateway)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">Gateway</span>
                <span className="color-hex">#9c27b0</span>
              </div>
            </div>
            <div className="color-card" style={{ '--node-color': 'var(--node-approval)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">Approval</span>
                <span className="color-hex">#ffc107</span>
              </div>
            </div>
            <div className="color-card" style={{ '--node-color': 'var(--node-end)' } as any}>
              <div className="color-swatch"></div>
              <div className="color-info">
                <span className="color-name">End</span>
                <span className="color-hex">#f44336</span>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
};
