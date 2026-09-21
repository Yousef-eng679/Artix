import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ProjectWorkspaceLayout } from '@/components/ProjectWorkspace/ProjectWorkspaceLayout';

describe('Phase 2: ProjectWorkspaceLayout Component', () => {
  it('renders desktop sidebar container and main children', () => {
    const onMobileOpenChange = vi.fn();
    render(
      <ProjectWorkspaceLayout
        projectName="Test Project"
        isMobileOpen={false}
        onMobileOpenChange={onMobileOpenChange}
        sidebar={<div data-testid="sidebar-content">Sidebar Navigation</div>}
      >
        <div data-testid="main-content">Workspace Main Content</div>
      </ProjectWorkspaceLayout>
    );

    // Sidebar and main content are rendered
    expect(screen.getByTestId('sidebar-content')).toBeInTheDocument();
    expect(screen.getByTestId('main-content')).toBeInTheDocument();
  });

  it('renders mobile header and opens mobile drawer on hamburger click', () => {
    const onMobileOpenChange = vi.fn();
    render(
      <ProjectWorkspaceLayout
        projectName="Alpha Project"
        isMobileOpen={false}
        onMobileOpenChange={onMobileOpenChange}
        sidebar={<div data-testid="sidebar-content">Sidebar Navigation</div>}
      >
        <div>Content</div>
      </ProjectWorkspaceLayout>
    );

    // Mobile header button
    const menuBtn = screen.getByLabelText('Open navigation menu');
    expect(menuBtn).toBeInTheDocument();

    fireEvent.click(menuBtn);
    expect(onMobileOpenChange).toHaveBeenCalledWith(true);
  });
});
