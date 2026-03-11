import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QaInbox } from './qa-inbox';
import { QaDataService } from '../../services/qa-data.service';
import { QaItem } from '../../models/qa-item.model';

describe('QaInbox', () => {
  let component: QaInbox;
  let fixture: ComponentFixture<QaInbox>;

  const initialItems: QaItem[] = [
    {
      id: '1',
      title: 'No replies yet',
      body: '   ',
      link: 'https://www.udemy.com/q/1',
      num_replies: 0,
      num_upvotes: 0,
      has_instructor_reply: false,
      answered: false,
      courseInfo: { id: '100', title: 'Course A' }
    },
    {
      id: '2',
      title: 'Student replied only',
      body: 'Student context',
      link: 'https://www.udemy.com/q/2',
      num_replies: 2,
      num_upvotes: 1,
      has_instructor_reply: false,
      has_top_answer: false,
      answered: true,
      courseInfo: { id: '100', title: 'Course A' }
    }
  ];

  const storeMock = {
    getAll: jasmine.createSpy('getAll').and.callFake(() => JSON.parse(JSON.stringify(initialItems))),
    setAll: jasmine.createSpy('setAll'),
    clear: jasmine.createSpy('clear')
  } as unknown as QaDataService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [QaInbox],
      providers: [{ provide: QaDataService, useValue: storeMock }]
    }).compileComponents();

    fixture = TestBed.createComponent(QaInbox);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    (storeMock.getAll as jasmine.Spy).calls.reset();
    (storeMock.setAll as jasmine.Spy).calls.reset();
    (storeMock.clear as jasmine.Spy).calls.reset();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should classify needs-help entries from imported metadata', () => {
    const studentOnly = component.items.find((x) => x.id === '2');
    expect(studentOnly?.needs_help).toBeTrue();
    expect(studentOnly?.pure_unanswered).toBeFalse();
  });

  it('should keep track key stable regardless of render index', () => {
    const item = component.items[0];
    expect(component.trackItem(0, item)).toEqual(component.trackItem(99, item));
  });

  it('should fall back snippet text to title when body is empty', () => {
    const noBody = component.items.find((x) => x.id === '1');
    expect(component.isBodyFallback(noBody as QaItem)).toBeTrue();
    expect(component.snippetText(noBody as QaItem)).toBe('No replies yet');
  });

  it('should filter unanswered only when toggle is enabled', () => {
    component.showUnansweredOnly = true;
    component.onFiltersChanged();

    expect(component.filteredItems.length).toBe(1);
    expect(component.filteredItems[0].id).toBe('1');
  });

  it('should hide item from default view and show it in hidden view', () => {
    const target = component.items.find((x) => x.id === '2') as QaItem;

    component.toggleHidden(target);
    component.viewMode = 'default';
    component.onFiltersChanged();
    expect(component.filteredItems.some((x) => x.id === '2')).toBeFalse();

    component.viewMode = 'hidden';
    component.onFiltersChanged();
    expect(component.filteredItems.some((x) => x.id === '2')).toBeTrue();
  });

  it('should include hidden+important item in important view while excluding it from default', () => {
    const target = component.items.find((x) => x.id === '2') as QaItem;

    component.toggleHidden(target);
    component.toggleImportant(target);

    component.viewMode = 'default';
    component.onFiltersChanged();
    expect(component.filteredItems.some((x) => x.id === '2')).toBeFalse();

    component.viewMode = 'important';
    component.onFiltersChanged();
    expect(component.filteredItems.some((x) => x.id === '2')).toBeTrue();
  });

  it('should persist hidden and important state changes', () => {
    const target = component.items.find((x) => x.id === '2') as QaItem;

    component.toggleHidden(target);
    component.toggleImportant(target);

    const latestPersisted = (storeMock.setAll as jasmine.Spy).calls.mostRecent().args[0] as QaItem[];
    const persistedTarget = latestPersisted.find((x) => x.id === '2');

    expect(persistedTarget?.is_hidden).toBeTrue();
    expect(persistedTarget?.is_important).toBeTrue();
  });
});
