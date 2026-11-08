import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { Card } from '../Card';
import { Input } from '../Input';
import { Pagination } from '../Pagination';
import { Spinner } from '../Spinner';

import { Table, TableBody, TableCell, TableColumn, TableHeader, TableRow } from './Table';

const meta = {
  title: 'da-v2/Table',
  component: Table,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story: () => React.ReactNode) => (
      <div className='clay-stage w-full max-w-[760px] overflow-x-auto p-8'>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Table>;

export default meta;
type Story = StoryObj<typeof meta>;

/* ---------- placeholder data ---------- */
interface Student {
  id: string;
  name: string;
  email: string;
  grade: string;
  date: string;
}

const STUDENTS: Student[] = [
  { id: '1', name: 'Ahmed Mohamed', email: 'ahmed@example.com', grade: 'Grade 12', date: '2026-04-12' },
  { id: '2', name: 'Fatima Ali', email: 'fatima@example.com', grade: 'Grade 11', date: '2026-04-10' },
  { id: '3', name: 'Mahmoud Hassan', email: 'mahmoud@example.com', grade: 'Grade 10', date: '2026-04-09' },
  { id: '4', name: 'Mariam Khaled', email: 'mariam@example.com', grade: 'Grade 12', date: '2026-04-07' },
  { id: '5', name: 'Youssef Ibrahim', email: 'youssef@example.com', grade: 'Grade 11', date: '2026-04-04' },
  { id: '6', name: 'Nour Eldin', email: 'nour@example.com', grade: 'Grade 10', date: '2026-04-01' },
];

const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'grade', label: 'Grade' },
  { key: 'date', label: 'Date' },
];

/* ---------- 1. Static / basic ---------- */
export const Basic: Story = {
  render: () => (
    <Table aria-label='Students' selectionMode='none'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
        <TableColumn key='date'>Date</TableColumn>
      </TableHeader>
      <TableBody>
        {STUDENTS.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{s.name}</TableCell>
            <TableCell>{s.email}</TableCell>
            <TableCell>{s.grade}</TableCell>
            <TableCell>{s.date}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/* ---------- 2. Sortable (render-prop columns) ---------- */
export const Sortable: Story = {
  render: () => {
    const Demo = () => {
      const [sort, setSort] = React.useState({
        column: 'name' as React.Key,
        direction: 'ascending' as 'ascending' | 'descending',
      });
      const sorted = React.useMemo(() => {
        const arr = [...STUDENTS];
        const col = sort.column as keyof Student;
        arr.sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');

          return sort.direction === 'ascending' ? av.localeCompare(bv, 'en') : bv.localeCompare(av, 'en');
        });

        return arr;
      }, [sort]);

      return (
        <Table
          aria-label='Sortable students'
          onSortChange={(d) =>
            setSort({
              column: d.column ?? 'name',
              direction: d.direction ?? 'ascending',
            })
          }
          selectionMode='none'
          sortDescriptor={sort}
        >
          <TableHeader columns={COLUMNS}>
            {(c) => (
              <TableColumn key={c.key} allowsSorting>
                {c.label}
              </TableColumn>
            )}
          </TableHeader>
          <TableBody items={sorted}>
            {(item) => (
              <TableRow key={item.id}>{(k) => <TableCell>{String(item[k as keyof Student])}</TableCell>}</TableRow>
            )}
          </TableBody>
        </Table>
      );
    };

    return <Demo />;
  },
};

/* ---------- 3. Selectable (single) ---------- */
export const SingleSelect: Story = {
  render: () => (
    <Table aria-label='Single-select' selectionMode='single'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
        <TableColumn key='date'>Date</TableColumn>
      </TableHeader>
      <TableBody>
        {STUDENTS.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{s.name}</TableCell>
            <TableCell>{s.email}</TableCell>
            <TableCell>{s.grade}</TableCell>
            <TableCell>{s.date}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/* ---------- 4. Selectable (multiple) ---------- */
export const MultipleSelect: Story = {
  render: () => (
    <Table aria-label='Multi-select' selectionMode='multiple'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
        <TableColumn key='date'>Date</TableColumn>
      </TableHeader>
      <TableBody>
        {STUDENTS.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{s.name}</TableCell>
            <TableCell>{s.email}</TableCell>
            <TableCell>{s.grade}</TableCell>
            <TableCell>{s.date}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/* ---------- 5. Striped + compact ---------- */
export const StripedCompact: Story = {
  render: () => (
    <Table aria-label='Striped compact' isCompact isStriped selectionMode='none'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
        <TableColumn key='date'>Date</TableColumn>
      </TableHeader>
      <TableBody>
        {STUDENTS.map((s) => (
          <TableRow key={s.id}>
            <TableCell>{s.name}</TableCell>
            <TableCell>{s.email}</TableCell>
            <TableCell>{s.grade}</TableCell>
            <TableCell>{s.date}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/* ---------- 6. Sticky header ---------- */
export const StickyHeader: Story = {
  render: () => {
    const many: Student[] = Array.from({ length: 24 }, (_, i) => ({
      id: String(i + 1),
      name: `Student ${i + 1}`,
      email: `student${i + 1}@example.com`,
      grade: ['Grade 10', 'Grade 11', 'Grade 12'][i % 3],
      date: `2026-04-${String((i % 28) + 1).padStart(2, '0')}`,
    }));

    return (
      <Table aria-label='Sticky header' isHeaderSticky maxTableHeight={320} selectionMode='none'>
        <TableHeader>
          <TableColumn key='name'>Name</TableColumn>
          <TableColumn key='email'>Email</TableColumn>
          <TableColumn key='grade'>Grade</TableColumn>
          <TableColumn key='date'>Date</TableColumn>
        </TableHeader>
        <TableBody>
          {many.map((s) => (
            <TableRow key={s.id}>
              <TableCell>{s.name}</TableCell>
              <TableCell>{s.email}</TableCell>
              <TableCell>{s.grade}</TableCell>
              <TableCell>{s.date}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  },
};

/* ---------- 7. Empty state ---------- */
export const EmptyState: Story = {
  render: () => (
    <Table aria-label='Empty' selectionMode='none'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
      </TableHeader>
      <TableBody emptyContent='No students available'>{[]}</TableBody>
    </Table>
  ),
};

/* ---------- 8. Loading state ---------- */
export const LoadingState: Story = {
  render: () => (
    <Table aria-label='Loading' selectionMode='none'>
      <TableHeader>
        <TableColumn key='name'>Name</TableColumn>
        <TableColumn key='email'>Email</TableColumn>
        <TableColumn key='grade'>Grade</TableColumn>
      </TableHeader>
      <TableBody loadingContent={<Spinner size='md' />} loadingState='loading'>
        {[]}
      </TableBody>
    </Table>
  ),
};

/* ---------- 9. With top + bottom content ---------- */
export const WithTopAndBottomContent: Story = {
  render: () => {
    const Demo = () => {
      const [page, setPage] = React.useState(1);

      return (
        <Table
          aria-label='With top + bottom'
          bottomContent={
            <div className='flex justify-center'>
              <Pagination onChange={setPage} page={page} showControls size='sm' total={5} />
            </div>
          }
          selectionMode='none'
          topContent={
            <div className='flex items-center justify-between gap-3'>
              <Input aria-label='Search' className='max-w-xs' placeholder='Search for a student...' size='sm' />
              <span className='text-ink/70 text-[15px] font-bold'>{STUDENTS.length} students</span>
            </div>
          }
        >
          <TableHeader>
            <TableColumn key='name'>Name</TableColumn>
            <TableColumn key='email'>Email</TableColumn>
            <TableColumn key='grade'>Grade</TableColumn>
            <TableColumn key='date'>Date</TableColumn>
          </TableHeader>
          <TableBody>
            {STUDENTS.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.name}</TableCell>
                <TableCell>{s.email}</TableCell>
                <TableCell>{s.grade}</TableCell>
                <TableCell>{s.date}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    };

    return <Demo />;
  },
};

/* ---------- 10. Inside a Card (the `removeWrapper` case) ----------
   Renamed from `InsideTapedCard`: the tape and the tinted hard shadow it was
   built to show are both no-ops now, and a story called "taped" with no tape
   is worse documentation than a renamed id. What it actually demonstrates —
   the Card supplying the surface while the Table drops its own wrapper — is
   still worth a story. */
export const InsideCard: Story = {
  render: () => (
    <Card className='w-full max-w-[680px] overflow-x-auto'>
      <div className='p-4 pt-8'>
        <Table aria-label='Inside card' removeWrapper selectionMode='none'>
          <TableHeader>
            <TableColumn key='name'>Name</TableColumn>
            <TableColumn key='email'>Email</TableColumn>
            <TableColumn key='grade'>Grade</TableColumn>
          </TableHeader>
          <TableBody>
            {STUDENTS.slice(0, 4).map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.name}</TableCell>
                <TableCell>{s.email}</TableCell>
                <TableCell>{s.grade}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  ),
};
