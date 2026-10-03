'use client'

import React, { useState } from 'react'
import { AppShell } from '@/components/layout/AppShell'
import {
  Button,
  Input,
  Select,
  Textarea,
  Checkbox,
  Card,
  Table,
  Modal,
  Toast,
  Badge,
  Tabs,
  Tooltip,
  Skeleton,
  EmptyState,
  ErrorState,
} from '@/components/ui'

export default function DesignPage() {
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedTab, setSelectedTab] = useState('buttons')

  const tabContent = {
    buttons: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Button Variants</h3>
          <div className="flex flex-wrap gap-4">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Button Sizes</h3>
          <div className="flex flex-wrap gap-4 items-center">
            <Button size="sm">Small</Button>
            <Button size="md">Medium</Button>
            <Button size="lg">Large</Button>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Button States</h3>
          <div className="flex flex-wrap gap-4">
            <Button>Default</Button>
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </div>
    ),

    inputs: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Input</h3>
          <div className="max-w-md space-y-4">
            <Input label="Name" placeholder="Enter your name" />
            <Input label="Email" type="email" placeholder="Enter your email" />
            <Input label="Password" type="password" placeholder="Enter password" />
            <Input label="With Error" error="This field is required" />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Select</h3>
          <div className="max-w-md space-y-4">
            <Select
              label="Category"
              options={[
                { value: '1', label: 'Option 1' },
                { value: '2', label: 'Option 2' },
                { value: '3', label: 'Option 3' },
              ]}
            />
            <Select
              label="With Error"
              error="Please select an option"
              options={[
                { value: '1', label: 'Option 1' },
                { value: '2', label: 'Option 2' },
              ]}
            />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Textarea</h3>
          <div className="max-w-md space-y-4">
            <Textarea label="Description" placeholder="Enter description" rows={4} />
            <Textarea label="With Error" error="This field is required" rows={4} />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Checkbox</h3>
          <div className="space-y-4">
            <Checkbox label="I agree to the terms" />
            <Checkbox label="Subscribe to newsletter" defaultChecked />
            <Checkbox label="Disabled checkbox" disabled />
          </div>
        </div>
      </div>
    ),

    cards: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Card Variants</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card variant="default">
              <div className="p-6">
                <h4 className="text-lg font-semibold mb-2">Default Card</h4>
                <p className="text-decoricks-dark/60">This is a default card with glass effect.</p>
              </div>
            </Card>
            <Card variant="dark">
              <div className="p-6">
                <h4 className="text-lg font-semibold mb-2">Dark Card</h4>
                <p className="text-decoricks-light/60">This is a dark card with glass effect.</p>
              </div>
            </Card>
          </div>
        </div>
      </div>
    ),

    tables: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Table</h3>
          <Card>
            <div className="p-6">
              <Table
                columns={[
                  { key: 'name', label: 'Name' },
                  { key: 'email', label: 'Email' },
                  { key: 'status', label: 'Status' },
                ]}
                data={[
                  { name: 'John Doe', email: 'john@example.com', status: 'Active' },
                  { name: 'Jane Smith', email: 'jane@example.com', status: 'Inactive' },
                  { name: 'Bob Johnson', email: 'bob@example.com', status: 'Active' },
                ]}
                pagination={{
                  currentPage: 1,
                  totalPages: 5,
                  onPageChange: (page) => console.log('Page:', page),
                }}
              />
            </div>
          </Card>
        </div>
      </div>
    ),

    modals: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Modal</h3>
          <Button onClick={() => setIsModalOpen(true)}>Open Modal</Button>

          <Modal
            isOpen={isModalOpen}
            onClose={() => setIsModalOpen(false)}
            title="Example Modal"
            size="md"
          >
            <p className="text-decoricks-dark mb-4">
              This is an example modal with the Liquid Glass design. It features a backdrop blur
              effect and smooth animations.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setIsModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setIsModalOpen(false)}>Confirm</Button>
            </div>
          </Modal>
        </div>
      </div>
    ),

    badges: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Badge Variants</h3>
          <div className="flex flex-wrap gap-4">
            <Badge variant="default">Default</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="error">Error</Badge>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Badge Sizes</h3>
          <div className="flex flex-wrap gap-4 items-center">
            <Badge size="sm">Small</Badge>
            <Badge size="md">Medium</Badge>
          </div>
        </div>
      </div>
    ),

    tabs: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Tabs</h3>
          <Tabs
            tabs={[
              { id: 'tab1', label: 'Tab 1' },
              { id: 'tab2', label: 'Tab 2' },
              { id: 'tab3', label: 'Tab 3' },
            ]}
            defaultTab="tab1"
          >
            {(activeTab) => (
              <div className="p-4 glass rounded-lg">
                <p>Active tab: {activeTab}</p>
              </div>
            )}
          </Tabs>
        </div>
      </div>
    ),

    tooltips: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Tooltip</h3>
          <div className="flex flex-wrap gap-4">
            <Tooltip content="This is a tooltip">
              <Button>Hover me</Button>
            </Tooltip>
            <Tooltip content="Tooltip on top" position="top">
              <Button>Top</Button>
            </Tooltip>
            <Tooltip content="Tooltip on bottom" position="bottom">
              <Button>Bottom</Button>
            </Tooltip>
            <Tooltip content="Tooltip on left" position="left">
              <Button>Left</Button>
            </Tooltip>
            <Tooltip content="Tooltip on right" position="right">
              <Button>Right</Button>
            </Tooltip>
          </div>
        </div>
      </div>
    ),

    skeletons: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Skeleton Loading</h3>
          <div className="space-y-4 max-w-md">
            <Skeleton variant="text" width="100%" />
            <Skeleton variant="text" width="80%" />
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="rect" width="100%" height="100px" />
            <div className="flex gap-4">
              <Skeleton variant="circle" width="40px" height="40px" />
              <Skeleton variant="rect" width="200px" height="40px" />
            </div>
          </div>
        </div>
      </div>
    ),

    states: (
      <div className="space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-4">Empty State</h3>
          <Card>
            <EmptyState
              title="No data found"
              description="There are no items to display at this time."
              action={{ label: 'Create Item', onClick: () => console.log('Create') }}
            />
          </Card>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Error State</h3>
          <Card>
            <ErrorState
              title="Something went wrong"
              description="An error occurred while loading the data. Please try again."
              action={{ label: 'Retry', onClick: () => console.log('Retry') }}
            />
          </Card>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-4">Toast</h3>
          <div className="space-y-4 max-w-md">
            <Toast message="Success message" type="success" />
            <Toast message="Error message" type="error" />
            <Toast message="Warning message" type="warning" />
            <Toast message="Info message" type="info" />
          </div>
        </div>
      </div>
    ),
  }

  return (
    <AppShell>
      <div className="max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-decoricks-dark mb-6">Design System</h1>

        <Tabs
          tabs={[
            { id: 'buttons', label: 'Buttons' },
            { id: 'inputs', label: 'Inputs' },
            { id: 'cards', label: 'Cards' },
            { id: 'tables', label: 'Tables' },
            { id: 'modals', label: 'Modals' },
            { id: 'badges', label: 'Badges' },
            { id: 'tabs', label: 'Tabs' },
            { id: 'tooltips', label: 'Tooltips' },
            { id: 'skeletons', label: 'Skeletons' },
            { id: 'states', label: 'States' },
          ]}
          defaultTab="buttons"
        >
          {(activeTab) => <div className="mt-6">{tabContent[activeTab as keyof typeof tabContent]}</div>}
        </Tabs>
      </div>
    </AppShell>
  )
}
